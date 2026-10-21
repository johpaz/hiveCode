import { eventBus } from "../events/event-bus"
import type { SwarmCollaboration } from "../ipc/protocol"

/** Actual execution boundaries, never inferred from model text. Observability must not stop work. */
export function trackCollaboration(input: {
  from: string; to: string; taskId?: string; sessionId?: string; summary: string
}): (ok: boolean, summary?: string) => void {
  const delegationId = crypto.randomUUID()
  let settled = false
  const emit = (kind: SwarmCollaboration["kind"], summary: string) => {
    try {
      eventBus.emit("swarm:collaboration", {
        event_id: crypto.randomUUID(), delegation_id: delegationId,
        task_id: input.taskId, session_id: input.sessionId,
        from: input.from, to: input.to, kind,
        summary: summary.replace(/\s+/g, " ").trim().slice(0, 240), at: Date.now(),
      })
    } catch { /* A disconnected observer cannot interrupt an agent. */ }
  }
  emit("delegation", input.summary)
  return (ok, summary = input.summary) => {
    if (settled) return
    settled = true
    emit(ok ? "handoff" : "failed", summary)
  }
}
