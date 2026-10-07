/**
 * Applying a session change the user asked for.
 *
 * The parser decides WHAT should happen (`/session resume` names a session,
 * `/session new` closes the current one) but never touches the runtime — the
 * CoordinatorManager owns every session write. This module is the seam between
 * the two: it takes the parser's request and performs it against the live
 * runtime and the TUI.
 *
 * It was inlined in repl.ts's `onSubmit`, which made the only interesting
 * decision in the file — switch, close, or do nothing — untestable without
 * booting the whole REPL.
 */
import type { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"

export interface SessionSwitchRequest {
  /** `null` closes the session; the next user message opens a new one. */
  sessionId: string | null
  projectPath?: string
}

export interface SessionSwitchDeps {
  manager: Pick<CoordinatorManager, "getSessionId" | "switchSession" | "endSession">
  /** Re-send the snapshot for a session, so the TUI is not left empty. */
  refreshSession: ((sessionId: string) => Promise<void>) | null
  /** Where the picker and the project context fall back to. */
  defaultProjectPath: string
}

export type SessionSwitchOutcome =
  /** Moved to another session and refilled the TUI. */
  | "switched"
  /** Closed the session; the TUI was told, nothing to re-send. */
  | "ended"
  /** Already there, or no session to close. */
  | "noop"

/**
 * Perform a requested session change.
 *
 * Switching also refills the TUI: `switchSession` emits `session_changed`, which
 * clears the transcript and every per-session panel, so without the refresh the
 * user would stare at an empty screen until they typed again. Closing needs no
 * snapshot — there is nothing to show.
 */
export async function applySessionSwitch(
  request: SessionSwitchRequest,
  deps: SessionSwitchDeps,
): Promise<SessionSwitchOutcome> {
  const target = request.sessionId

  if (target === null) {
    if (!deps.manager.getSessionId()) return "noop"
    deps.manager.endSession()
    return "ended"
  }

  if (target === deps.manager.getSessionId()) return "noop"

  deps.manager.switchSession(target, request.projectPath ?? deps.defaultProjectPath)
  await deps.refreshSession?.(target)
  return "switched"
}