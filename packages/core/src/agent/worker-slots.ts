/**
 * How many workers of one task run at once, whichever tool launched them (`task_delegate`
 * instances and `spawn_agent` children share the same count).
 *
 * The cap used to live only in BEE's prompt, and five workers ran at once against a budget that
 * three could not even finish. A worker that does not fit waits its turn (first come, first
 * served) instead of failing, so BEE's parallel calls still all complete, just not all together.
 * Readers (scouts, planners) are capped lower than writers: they all pay for the same context.
 */

const DEFAULT_MAX_WORKERS = 3
const DEFAULT_MAX_READERS = 2

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export const maxActiveWorkers = (): number => limit("HIVECODE_MAX_WORKERS", DEFAULT_MAX_WORKERS)
export const maxActiveReaders = (): number => Math.min(maxActiveWorkers(), limit("HIVECODE_MAX_READERS", DEFAULT_MAX_READERS))

interface Waiter { readOnly: boolean; grant: () => void }
interface TaskSlots { active: number; readers: number; queue: Waiter[] }

const tasks = new Map<string, TaskSlots>()

const fits = (slots: TaskSlots, readOnly: boolean) =>
  slots.active < maxActiveWorkers() && (!readOnly || slots.readers < maxActiveReaders())

function take(slots: TaskSlots, readOnly: boolean): void {
  slots.active++
  if (readOnly) slots.readers++
}

/** Hands free slots to the queue in arrival order; a reader that does not fit lets a later writer through. */
function drain(key: string, slots: TaskSlots): void {
  for (let i = 0; i < slots.queue.length;) {
    const waiter = slots.queue[i]
    if (!fits(slots, waiter.readOnly)) { i++; continue }
    slots.queue.splice(i, 1)
    take(slots, waiter.readOnly)
    waiter.grant()
  }
  if (slots.active === 0 && slots.queue.length === 0) tasks.delete(key)
}

/**
 * A place to run. Resolves with a `release` (call it once, in a `finally`) when the task has room;
 * rejects if `signal` aborts while waiting.
 */
export function acquireWorkerSlot(taskKey: string, options: { readOnly?: boolean; signal?: AbortSignal } = {}): Promise<() => void> {
  const readOnly = options.readOnly === true
  const slots = tasks.get(taskKey) ?? { active: 0, readers: 0, queue: [] }
  tasks.set(taskKey, slots)
  const release = () => {
    let done = false
    return () => {
      if (done) return
      done = true
      slots.active--
      if (readOnly) slots.readers--
      drain(taskKey, slots)
    }
  }
  if (fits(slots, readOnly)) { // the queue only ever holds waiters that did not fit, so there is nobody to jump ahead of
    take(slots, readOnly)
    return Promise.resolve(release())
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { readOnly, grant: () => { options.signal?.removeEventListener("abort", onAbort); resolve(release()) } }
    const onAbort = () => {
      const at = slots.queue.indexOf(waiter)
      if (at >= 0) slots.queue.splice(at, 1)
      drain(taskKey, slots)
      reject(options.signal?.reason ?? new Error("Cancelled while waiting for a worker slot"))
    }
    if (options.signal?.aborted) return onAbort()
    options.signal?.addEventListener("abort", onAbort, { once: true })
    slots.queue.push(waiter)
  })
}

/** Workers running and waiting for a task; for tests and diagnostics. */
export function workerSlotUsage(taskKey: string): { active: number; waiting: number } {
  const slots = tasks.get(taskKey)
  return { active: slots?.active ?? 0, waiting: slots?.queue.length ?? 0 }
}
