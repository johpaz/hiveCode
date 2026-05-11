/**
 * Task WebSocket Streaming
 *
 * Integrates CoordinatorManager with the gateway's WebSocket system
 * to stream task narration, phase changes, and mode changes in real-time.
 *
 * Channels:
 *   - task:{taskId}:narration   — Narrative entries
 *   - task:{taskId}:phase       — Phase status changes
 *   - session:{sessionId}:mode  — Mode toggle events
 *
 * Usage: call broadcastTaskEvent() from CoordinatorManager
 */

import type { SessionMode } from "../workers/types"

// Global registry of WebSocket connections (populated by gateway)
const taskSubscribers = new Map<string, Set<WebSocket>>()
const sessionSubscribers = new Map<string, Set<WebSocket>>()

export function subscribeTask(ws: WebSocket, taskId: string): void {
  if (!taskSubscribers.has(taskId)) {
    taskSubscribers.set(taskId, new Set())
  }
  taskSubscribers.get(taskId)!.add(ws)
}

export function unsubscribeTask(ws: WebSocket, taskId: string): void {
  taskSubscribers.get(taskId)?.delete(ws)
}

export function subscribeSession(ws: WebSocket, sessionId: string): void {
  if (!sessionSubscribers.has(sessionId)) {
    sessionSubscribers.set(sessionId, new Set())
  }
  sessionSubscribers.get(sessionId)!.add(ws)
}

export function unsubscribeSession(ws: WebSocket, sessionId: string): void {
  sessionSubscribers.get(sessionId)?.delete(ws)
}

/** Remove a disconnected WebSocket from all subscriptions */
export function unsubscribeAll(ws: WebSocket): void {
  for (const set of taskSubscribers.values()) set.delete(ws)
  for (const set of sessionSubscribers.values()) set.delete(ws)
}

/** Broadcast a narrative entry for a task */
export function broadcastNarrative(taskId: string, entry: {
  coordinator: string
  phase: string
  content: string
  timestamp: string
}): void {
  const subscribers = taskSubscribers.get(taskId)
  if (!subscribers || subscribers.size === 0) return

  const msg = JSON.stringify({
    channel: `task:${taskId}:narration`,
    type: "narrative",
    data: entry,
  })

  for (const ws of subscribers) {
    if (ws.readyState === 1) { // OPEN
      ws.send(msg)
    }
  }
}

/** Broadcast a phase status change */
export function broadcastPhase(taskId: string, phase: {
  name: string
  status: string
  coordinator: string
  durationMs?: number
}): void {
  const subscribers = taskSubscribers.get(taskId)
  if (!subscribers || subscribers.size === 0) return

  const msg = JSON.stringify({
    channel: `task:${taskId}:phase`,
    type: "phase",
    data: phase,
  })

  for (const ws of subscribers) {
    if (ws.readyState === 1) {
      ws.send(msg)
    }
  }
}

/** Broadcast a mode change for a session */
export function broadcastMode(sessionId: string, mode: SessionMode, phase?: string): void {
  const subscribers = sessionSubscribers.get(sessionId)
  if (!subscribers || subscribers.size === 0) return

  const msg = JSON.stringify({
    channel: `session:${sessionId}:mode`,
    type: "mode",
    data: { mode, phase, timestamp: new Date().toISOString() },
  })

  for (const ws of subscribers) {
    if (ws.readyState === 1) {
      ws.send(msg)
    }
  }
}

/** SSE-compatible stream generator for task events */
export async function* taskEventStream(taskId: string): AsyncGenerator<string> {
  // This would be used by the gateway's SSE endpoint
  // For now, it's a stub that can be enhanced with EventEmitter integration
  yield `data: ${JSON.stringify({ type: "connected", taskId })}\n\n`
}
