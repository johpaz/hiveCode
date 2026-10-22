import path from "node:path"

interface Waiter { writer?: string; resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void }
interface Queue { active: number; writers: Set<string>; pending: Waiter[] }
const queues = new Map<string, Queue>()
const workspaceWriters = new Set<string>()
/**
 * Writers collide when one path is the other or contains it: a shell command (locking its whole
 * workspace) excludes a file write inside it, while two writes to different files may run together.
 */
function collides(writer: string): boolean {
  for (const held of workspaceWriters) {
    if (held === writer || held.startsWith(writer + path.sep) || writer.startsWith(held + path.sep)) return true
  }
  return false
}
/** No limit unless HIVE_MAX_AGENT_CONCURRENCY sets one (a provider's rate limit is the user's to configure). */
export const DEFAULT_AGENT_CONCURRENCY = Infinity

function limit(): number {
  const value = Number(process.env.HIVE_MAX_AGENT_CONCURRENCY)
  return Number.isFinite(value) && value >= 1 ? Math.min(32, Math.floor(value)) : DEFAULT_AGENT_CONCURRENCY
}
function drain(key: string, queue: Queue): void {
  for (let i = 0; i < queue.pending.length && queue.active < limit();) {
    const job = queue.pending[i]
    if (job.writer && collides(job.writer)) { i++; continue }
    queue.pending.splice(i, 1)
    if (job.abort) job.signal?.removeEventListener("abort", job.abort)
    queue.active++
    if (job.writer) { queue.writers.add(job.writer); workspaceWriters.add(job.writer) }
    let released = false
    job.resolve(() => {
      if (released) return
      released = true
      queue.active--
      if (job.writer) { queue.writers.delete(job.writer); workspaceWriters.delete(job.writer) }
      for (const [otherKey, otherQueue] of queues) drain(otherKey, otherQueue)
      if (queue.active === 0 && queue.pending.length === 0) queues.delete(key)
    })
  }
}
/** Waiting for a child holds no slot. Bound actual model/tool execution, not idle parents. */
export async function withExecutionSlot<T>(session: string, signal: AbortSignal | undefined, work: () => Promise<T>, writerWorkspace?: string | null): Promise<T> {
  signal?.throwIfAborted()
  const queue = queues.get(session) ?? { active: 0, writers: new Set<string>(), pending: [] }
  queues.set(session, queue)
  const release = await new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, signal, writer: writerWorkspace ? path.resolve(writerWorkspace) : undefined }
    waiter.abort = () => {
      const index = queue.pending.indexOf(waiter)
      if (index >= 0) queue.pending.splice(index, 1)
      reject(signal?.reason ?? new Error("Execution cancelled"))
      if (queue.active === 0 && queue.pending.length === 0) queues.delete(session)
    }
    signal?.addEventListener("abort", waiter.abort, { once: true })
    queue.pending.push(waiter)
    drain(session, queue)
  })
  try { signal?.throwIfAborted(); return await work() } finally { release() }
}
