/**
 * The workers of one task that are running, whichever tool launched them (`task_delegate` instances and
 * `spawn_agent` children share the same count).
 *
 * There is no cap: every worker starts as soon as it is delegated. Slots used to hold the extra ones in a queue, so a
 * review of three modules ran two scouts and left the third waiting for no reason the user could see. The count stays
 * only so tests and diagnostics can tell what is running.
 */

const active = new Map<string, number>()

/** Registers a running worker; resolves at once with a `release` to call once, in a `finally`. */
export function acquireWorkerSlot(taskKey: string, options: { readOnly?: boolean; signal?: AbortSignal } = {}): Promise<() => void> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error("Cancelled before the worker started"))
  active.set(taskKey, (active.get(taskKey) ?? 0) + 1)
  let done = false
  return Promise.resolve(() => {
    if (done) return
    done = true
    const left = (active.get(taskKey) ?? 1) - 1
    if (left > 0) active.set(taskKey, left)
    else active.delete(taskKey)
  })
}

/** Workers running for a task; for tests and diagnostics. */
export function workerSlotUsage(taskKey: string): { active: number } {
  return { active: active.get(taskKey) ?? 0 }
}
