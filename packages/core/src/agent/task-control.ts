/**
 * Control of running work from outside the screen (Telegram's /stop and /new, cancel buttons).
 *
 * Three small pieces, none of which needs to know about the others' packages:
 *  - the runs started from a channel, each with an AbortController the channel can fire;
 *  - the coordinator's own controls, registered by the code package the way the swarm runtime is;
 *  - thread epochs, so "start over" never has to delete anybody's history.
 */
import { col } from "../storage/hive";
import type { CodeConfigDoc } from "../storage/collections";

// ── Runs started from a channel ──────────────────────────────────────────────

const channelRuns = new Map<string, AbortController>();

/** Registers a run for `key` (`telegram:<chat>`); a run that was still going for the same key is replaced. */
export function beginChannelRun(key: string): AbortController {
  const controller = new AbortController();
  channelRuns.set(key, controller);
  return controller;
}

export function endChannelRun(key: string, controller: AbortController): void {
  if (channelRuns.get(key) === controller) channelRuns.delete(key);
}

/** Aborts the run of `key`. False when nothing was running. */
export function stopChannelRun(key: string): boolean {
  const controller = channelRuns.get(key);
  if (!controller || controller.signal.aborted) return false;
  controller.abort(new Error("Stopped from the channel"));
  channelRuns.delete(key);
  return true;
}

// ── The coordinator's controls ───────────────────────────────────────────────

export interface CoordinatorControl {
  /** Cancels the task the coordinator is running, if any. */
  cancelActive(): Promise<{ taskId: string; title?: string } | null>;
  cancelTask(taskId: string): Promise<void>;
  /** Closes the session; the next message opens a new one. False when none was open. */
  closeSession(): boolean;
  hasActiveTask(): boolean;
}

let control: CoordinatorControl | null = null;

export function registerCoordinatorControl(next: CoordinatorControl | null): void {
  control = next;
}

export function getCoordinatorControl(): CoordinatorControl | null {
  return control;
}

// ── Thread epochs ────────────────────────────────────────────────────────────

const epochKey = (scope: string) => `thread_epoch:${scope}`;

/**
 * The thread a person talks in: the base thread, plus an epoch once they started over. `scope` names who is
 * asking (`telegram:<chat>`), which is not always what names the thread (the user's internal id).
 */
export async function currentThreadId(threadBase: string, scope = threadBase): Promise<string> {
  const epoch = (await (await col<CodeConfigDoc>("codeConfig")).get(epochKey(scope)))?.doc.value;
  return epoch && epoch !== "0" ? `${threadBase}~${epoch}` : threadBase;
}

/** Starts a fresh conversation for `scope`. The old one stays in the database, just no longer loaded. */
export async function startNewThread(scope: string): Promise<number> {
  const config = await col<CodeConfigDoc>("codeConfig");
  const existing = await config.get(epochKey(scope));
  const next = (Number(existing?.doc.value) || 0) + 1;
  await config.put(epochKey(scope), { key: epochKey(scope), value: String(next), updated_at: Math.floor(Date.now() / 1000) }, { expectedVersion: existing?.version ?? 0 });
  return next;
}
