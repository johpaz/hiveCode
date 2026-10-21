/**
 * Who has finished what, among the tasks delegated in this process.
 *
 * `task_delegate({ after: ["T001"] })` and the workers' `wait_for` park here until the task they
 * depend on settles. A parked call holds no execution slot and, for `after`, has not started its
 * model run yet, so waiting costs neither tokens nor a place in the queue. The reference may be
 * announced a moment after the waiter asks (both calls of one batch start together), so an unknown
 * reference is awaited for a grace period before it is reported as unknown.
 */
export interface BoardEntry {
  ref?: string
  taskId?: string
  status: "completed" | "blocked" | "failed"
  result: string
}

interface Slot { promise: Promise<BoardEntry>; resolve: (entry: BoardEntry) => void; settled?: BoardEntry }

const slots = new Map<string, Slot>()
const key = (value: string) => value.trim().toLowerCase()

function slotFor(name: string): Slot {
  const k = key(name)
  let slot = slots.get(k)
  if (!slot) {
    let resolve!: (entry: BoardEntry) => void
    const promise = new Promise<BoardEntry>(r => { resolve = r })
    slot = { promise, resolve }
    slots.set(k, slot)
  }
  return slot
}

/** Announces a delegation as running; `names` are its ref and task id. */
export function announceDelegation(...names: Array<string | undefined>): void {
  for (const name of names) {
    if (!name) continue
    // A ref reused by a later run starts over: the old outcome is not this task's.
    if (slots.get(key(name))?.settled) slots.delete(key(name))
    slotFor(name)
  }
}

/** Records the outcome under every name the task goes by. */
export function settleDelegation(entry: BoardEntry, ...names: Array<string | undefined>): void {
  for (const name of names) {
    if (!name) continue
    const slot = slotFor(name)
    slot.settled = entry
    slot.resolve(entry)
  }
}

export function delegationOutcome(name: string): BoardEntry | undefined {
  return slots.get(key(name))?.settled
}

/** True when something announced `name` (running or settled). */
export function isAnnounced(name: string): boolean {
  return slots.has(key(name))
}

export type AwaitResult =
  | { ok: true; entry: BoardEntry }
  | { ok: false; reason: "unknown" | "timeout" | "aborted" }

/**
 * Waits for `name` to settle. A name nobody announced within `graceMs` is "unknown"; one announced
 * but not settled within `timeoutMs` is "timeout".
 */
export async function awaitDelegation(name: string, opts: { signal?: AbortSignal; timeoutMs?: number; graceMs?: number; known?: boolean } = {}): Promise<AwaitResult> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.HIVE_SWARM_WAIT_MS ?? 20 * 60_000)
  const graceMs = opts.graceMs ?? Number(process.env.HIVE_SWARM_GRACE_MS ?? 15_000)
  const known = opts.known ?? slots.has(key(name))
  const slot = slotFor(name)
  if (slot.settled) return { ok: true, entry: slot.settled }
  // Not announced yet: give the sibling call of the same batch a moment to register.
  const budget = known ? timeoutMs : graceMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await new Promise<AwaitResult>(resolve => {
    const onAbort = () => resolve({ ok: false, reason: "aborted" })
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => resolve({ ok: false, reason: known ? "timeout" : "unknown" }), budget)
    slot.promise.then(entry => resolve({ ok: true, entry }))
  })
  if (timer) clearTimeout(timer)
  return outcome
}

/** Test and run boundary: forget everything. */
export function resetDelegationBoard(): void {
  slots.clear()
}
