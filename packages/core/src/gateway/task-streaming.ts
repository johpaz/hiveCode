/**
 * Task WebSocket Streaming
 *
 * Manages WebSocket subscriptions for task narration, phase updates,
 * and session mode changes. Used by the gateway to broadcast events
 * to connected dashboard clients.
 */

import type { ServerWebSocket } from "bun";

type SessionMode = "plan" | "approval" | "auto";

const taskSubscribers = new Map<string, Set<ServerWebSocket<unknown>>>();
const sessionSubscribers = new Map<string, Set<ServerWebSocket<unknown>>>();

// Dashboard subscribers receive ALL narrative/phase/mode events globally
// (no task/session filter). Used by the Hive Terminal dashboard.
const dashboardSubscribers = new Set<ServerWebSocket<unknown>>();

export function subscribeTask(ws: ServerWebSocket<unknown>, taskId: string): void {
  if (!taskSubscribers.has(taskId)) {
    taskSubscribers.set(taskId, new Set());
  }
  taskSubscribers.get(taskId)!.add(ws);
}

export function unsubscribeTask(ws: ServerWebSocket<unknown>, taskId: string): void {
  taskSubscribers.get(taskId)?.delete(ws);
}

export function subscribeSession(ws: ServerWebSocket<unknown>, sessionId: string): void {
  if (!sessionSubscribers.has(sessionId)) {
    sessionSubscribers.set(sessionId, new Set());
  }
  sessionSubscribers.get(sessionId)!.add(ws);
}

export function unsubscribeSession(ws: ServerWebSocket<unknown>, sessionId: string): void {
  sessionSubscribers.get(sessionId)?.delete(ws);
}

/** Subscribe a WebSocket to global dashboard events (narrative, phase, mode) */
export function subscribeDashboard(ws: ServerWebSocket<unknown>): void {
  dashboardSubscribers.add(ws);
}

/** Unsubscribe a WebSocket from global dashboard events */
export function unsubscribeDashboard(ws: ServerWebSocket<unknown>): void {
  dashboardSubscribers.delete(ws);
}

/** Remove a disconnected WebSocket from all subscriptions */
export function unsubscribeAll(ws: ServerWebSocket<unknown>): void {
  for (const set of taskSubscribers.values()) set.delete(ws);
  for (const set of sessionSubscribers.values()) set.delete(ws);
  dashboardSubscribers.delete(ws);
}

/** Broadcast a narrative entry for a task */
export function broadcastNarrative(taskId: string, entry: {
  coordinator: string;
  phase: string;
  content: string;
  timestamp: string;
}): void {
  const msg = JSON.stringify({
    channel: `task:${taskId}:narration`,
    type: "narrative",
    data: entry,
  });

  // Send to task subscribers
  const subscribers = taskSubscribers.get(taskId);
  if (subscribers) {
    for (const ws of subscribers) {
      if (ws.readyState === 1) { // OPEN
        try { ws.send(msg); } catch { unsubscribeAll(ws); }
      }
    }
  }

  // Send to global dashboard subscribers
  for (const ws of dashboardSubscribers) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { unsubscribeAll(ws); }
    }
  }
}

/** Broadcast a phase status change */
export function broadcastPhase(taskId: string, phase: {
  name: string;
  status: string;
  coordinator: string;
  durationMs?: number;
}): void {
  const msg = JSON.stringify({
    channel: `task:${taskId}:phase`,
    type: "phase",
    data: phase,
  });

  const subscribers = taskSubscribers.get(taskId);
  if (subscribers) {
    for (const ws of subscribers) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch { unsubscribeAll(ws); }
      }
    }
  }

  for (const ws of dashboardSubscribers) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { unsubscribeAll(ws); }
    }
  }
}

/** Broadcast a mode change for a session */
export function broadcastMode(sessionId: string, mode: SessionMode, phase?: string): void {
  const msg = JSON.stringify({
    channel: `session:${sessionId}:mode`,
    type: "mode",
    data: { mode, phase, timestamp: new Date().toISOString() },
  });

  const subscribers = sessionSubscribers.get(sessionId);
  if (subscribers) {
    for (const ws of subscribers) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch { unsubscribeAll(ws); }
      }
    }
  }

  for (const ws of dashboardSubscribers) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { unsubscribeAll(ws); }
    }
  }
}

/** Broadcast a thinking block from an agent to the thinking channel */
export function broadcastThinking(agentId: string, thinking: {
  content: string;
  taskId?: string;
  durationMs?: number;
}): void {
  const msg = JSON.stringify({
    channel: `agent:${agentId}:thinking`,
    type: "thinking",
    data: {
      agentId,
      content: thinking.content,
      taskId: thinking.taskId,
      durationMs: thinking.durationMs,
      timestamp: new Date().toISOString(),
    },
  });

  // Send to task subscribers if taskId is provided
  if (thinking.taskId) {
    const subscribers = taskSubscribers.get(thinking.taskId);
    if (subscribers) {
      for (const ws of subscribers) {
        if (ws.readyState === 1) {
          try { ws.send(msg); } catch { unsubscribeAll(ws); }
        }
      }
    }
  }

  // Send to global dashboard subscribers
  for (const ws of dashboardSubscribers) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { unsubscribeAll(ws); }
    }
  }
}

// ── BeeEvent — Live Feed (TDD §15) ──────────────────────────────────────────

export type BeeState = "thinking" | "searching" | "reading" | "writing" | "executing" | "done" | "error";

export type BeeEvent =
  | { type: "tool_start";   taskId: string; agentId: string; tool: string; beeState: BeeState; activeForm?: string; timestamp: string }
  | { type: "tool_end";     taskId: string; agentId: string; tool: string; beeState: BeeState; durationMs: number; success: boolean; timestamp: string }
  | { type: "thinking";     taskId: string; agentId: string; content: string; beeState: "thinking"; timestamp: string }
  | { type: "narration";    taskId: string; agentId: string; coordinator: string; phase: string; content: string; beeState: BeeState; timestamp: string }
  | { type: "phase_start";  taskId: string; phase: string; coordinator: string; beeState: BeeState; timestamp: string }
  | { type: "phase_end";    taskId: string; phase: string; coordinator: string; beeState: BeeState; durationMs: number; timestamp: string }
  | { type: "task_end";     taskId: string; status: "completed" | "failed" | "cancelled"; beeState: "done" | "error"; durationMs: number; timestamp: string }
  | { type: "error";        taskId: string; agentId: string; message: string; beeState: "error"; timestamp: string };

function toolToBeeState(toolName: string): BeeState {
  if (toolName.startsWith("fs_read") || toolName === "parse_ast" || toolName === "git_log" || toolName === "git_diff" || toolName === "git_status") return "reading";
  if (toolName.startsWith("fs_write") || toolName.startsWith("fs_edit") || toolName.startsWith("fs_delete") || toolName === "git_commit") return "writing";
  if (toolName === "web_search" || toolName === "code_search" || toolName.startsWith("fs_glob") || toolName.startsWith("fs_list")) return "searching";
  if (toolName === "shell_executor" || toolName === "run_script" || toolName === "code_build" || toolName === "code_test" || toolName === "code_lint") return "executing";
  return "thinking";
}

type BeeEventListener = (event: BeeEvent) => void;
const beeEventListeners = new Set<BeeEventListener>();

/** Register a callback that fires on every BeeEvent (e.g. for Telegram bridging). Returns unsubscribe fn. */
export function onBeeEvent(fn: BeeEventListener): () => void {
  beeEventListeners.add(fn);
  return () => beeEventListeners.delete(fn);
}

function broadcastBeeEvent(event: BeeEvent): void {
  const msg = JSON.stringify({ channel: `task:${event.taskId}:bee`, type: "bee_event", data: event });
  const subscribers = taskSubscribers.get(event.taskId);
  if (subscribers) {
    for (const ws of subscribers) {
      if (ws.readyState === 1) { try { ws.send(msg); } catch { unsubscribeAll(ws); } }
    }
  }
  for (const ws of dashboardSubscribers) {
    if (ws.readyState === 1) { try { ws.send(msg); } catch { unsubscribeAll(ws); } }
  }
  for (const fn of beeEventListeners) { try { fn(event); } catch {} }
}

export function broadcastToolStart(taskId: string, agentId: string, tool: string, activeForm?: string): void {
  broadcastBeeEvent({ type: "tool_start", taskId, agentId, tool, beeState: toolToBeeState(tool), activeForm, timestamp: new Date().toISOString() });
}

export function broadcastToolEnd(taskId: string, agentId: string, tool: string, durationMs: number, success: boolean): void {
  broadcastBeeEvent({ type: "tool_end", taskId, agentId, tool, beeState: toolToBeeState(tool), durationMs, success, timestamp: new Date().toISOString() });
}

export function broadcastPhaseStart(taskId: string, phase: string, coordinator: string): void {
  broadcastBeeEvent({ type: "phase_start", taskId, phase, coordinator, beeState: "thinking", timestamp: new Date().toISOString() });
}

export function broadcastPhaseEnd(taskId: string, phase: string, coordinator: string, durationMs: number): void {
  broadcastBeeEvent({ type: "phase_end", taskId, phase, coordinator, beeState: "done", durationMs, timestamp: new Date().toISOString() });
}

export function broadcastTaskEnd(taskId: string, status: "completed" | "failed" | "cancelled", durationMs: number): void {
  broadcastBeeEvent({ type: "task_end", taskId, status, beeState: status === "completed" ? "done" : "error", durationMs, timestamp: new Date().toISOString() });
}

export function broadcastAgentError(taskId: string, agentId: string, message: string): void {
  broadcastBeeEvent({ type: "error", taskId, agentId, message, beeState: "error", timestamp: new Date().toISOString() });
}

/** SSE-compatible stream generator for task events */
export async function* taskEventStream(taskId: string): AsyncGenerator<string> {
  yield `data: ${JSON.stringify({ type: "connected", taskId })}\n\n`;
}
