/**
 * Per-tool confirmation through the UI.
 *
 * In `approval` mode a mutating tool waits for a person. Reading `process.stdin`
 * only works in a plain terminal; inside the TUI the keyboard belongs to the TUI
 * process, so the question has to travel over IPC instead: the loop asks here,
 * the launcher forwards it as `tool_approval_request`, and the TUI's answer comes
 * back through `resolveToolApproval`.
 */

export interface ToolApprovalRequest {
  request_id: string
  agent: string
  tool: string
  /** One line: what the call is about to do. */
  summary: string
  /** Longer view of the arguments, already truncated for display. */
  detail: string
  /** `gate` is a harness approval point (specification, convergence), not a tool call. */
  kind?: "tool" | "gate"
  /** Heading for the modal when it is not the default tool prompt. */
  title?: string
  /** Channel the run came from (`telegram`…). Its own approver is asked instead of the TUI. */
  channel?: string
}

type Requester = (request: ToolApprovalRequest) => void

const DETAIL_MAX = 1_200

let requester: Requester | null = null
/** Approvers of remote channels: a run that came from Telegram is answered with Telegram's buttons. */
const channelRequesters = new Map<string, Requester>()
/** Calls the person already declined, so a retry of the same call is not asked twice. */
const declined = new Set<string>()
const DECLINED_MAX = 200
const pending = new Map<string, (approved: boolean) => void>()
let counter = 0

/** The launcher registers how to reach the person; `null` unregisters it. */
export function registerToolApprovalRequester(fn: Requester | null): void {
  requester = fn
  if (!fn) {
    cancelPendingToolApprovals()
    declined.clear()
  }
}

/** A channel registers how to ask its person; `null` unregisters it. */
export function registerChannelApprovalRequester(channel: string, fn: Requester | null): void {
  if (fn) channelRequesters.set(channel, fn)
  else channelRequesters.delete(channel)
}

export function canRequestToolApproval(channel?: string): boolean {
  return (channel !== undefined && channelRequesters.has(channel)) || requester !== null
}

export function toolApprovalDetail(args: unknown, max = DETAIL_MAX): string {
  let text: string
  if (typeof args === "string") {
    text = args
  } else {
    try { text = JSON.stringify(args, null, 2) } catch { text = "[no serializable]" }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Resolves `true` when the person approves, `false` when they decline, the
 * request is cancelled or the run is aborted. Never rejects: a declined call is
 * an answer the model can act on, not an error of the loop.
 */
export function requestToolApproval(
  request: Omit<ToolApprovalRequest, "request_id">,
  signal?: AbortSignal,
  /** Groups declines: the same call is auto-declined again within the same scope (a task). */
  scope?: string,
): Promise<boolean> {
  const ask = (request.channel ? channelRequesters.get(request.channel) : undefined) ?? requester
  if (!ask) return Promise.resolve(false)
  if (signal?.aborted) return Promise.resolve(false)
  const key = scope ? `${scope}\u0000${request.tool}\u0000${request.detail}` : null
  if (key && declined.has(key)) return Promise.resolve(false)
  const request_id = `tool-approval-${Date.now().toString(36)}-${++counter}`
  return new Promise<boolean>((resolve) => {
    const finish = (approved: boolean) => {
      if (!pending.delete(request_id)) return
      signal?.removeEventListener("abort", onAbort)
      if (!approved && key && !signal?.aborted) {
        if (declined.size >= DECLINED_MAX) declined.delete(declined.values().next().value as string)
        declined.add(key)
      }
      resolve(approved)
    }
    const onAbort = () => finish(false)
    pending.set(request_id, finish)
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      ask({ request_id, ...request })
    } catch {
      finish(false)
    }
  })
}

/** Called with the TUI's answer. Returns whether the id was still waiting. */
export function resolveToolApproval(requestId: string, approved: boolean): boolean {
  const finish = pending.get(requestId)
  if (!finish) return false
  finish(approved)
  return true
}

/** Declines everything still waiting (the TUI went away). */
export function cancelPendingToolApprovals(): void {
  for (const finish of [...pending.values()]) finish(false)
}
