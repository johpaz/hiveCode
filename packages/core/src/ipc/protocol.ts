// Canonical IPC types shared between tui-launcher.ts and any gateway adapter.
// The Rust side (`ipc.rs`) mirrors these with serde.

export type IpcPriority = "critical" | "normal" | "low"

// ── Bun → TUI ─────────────────────────────────────────────────────────────────

export interface ModalField {
  key: string
  label: string
  placeholder: string
  required: boolean
  secret: boolean
  field_type: "text" | "select"
  options?: string[]
  default_value?: string
}

export type BunMessage =
  // critical priority — user must see before agents proceed
  | { type: "init";            mode: string; provider: string; model: string; project_name: string; project_path: string; session_id: string; version: string; task_count: number; token_count: number; workers: string[] }
  | { type: "conflict_alert";  agent: string; file: string; reason: string; severity: string }
  | { type: "file_risk_update"; path: string; risk: string; operation: string; adr_ref: string | null; reason: string; agent: string }
  // normal priority — live streaming output
  | { type: "history_append";  role: string; content: string; content_type?: string }
  | { type: "status";          running: boolean; msg: string }
  | { type: "state_update";    new_mode?: string; new_provider?: string; new_model?: string }
  | { type: "suggestions";     items: string[] }
  | { type: "quick_menu";      items: { label: string; cmd: string; desc: string }[] }
  | { type: "shell_output";    stdout: string; stderr: string; exit_code: number }
  | { type: "activity_update"; coordinator: string; phase: string; status: string }
  | { type: "narrative_chunk"; coordinator: string; phase: string; content: string; content_type?: string; stream_id?: string }
  | { type: "show_config_modal"; command: string; title: string; fields: ModalField[] }
  | { type: "show_info_modal"; title: string; content: string }
  | { type: "suspend" }
  | { type: "resume" }
  // low priority — informational, can lag
  | { type: "log_entry";          timestamp: string; level: string; source: string; message: string }
  | { type: "checkpoint_created"; checkpoint_id: string; description: string; file_count: number; agent: string }
  | { type: "checkpoint_rollback"; checkpoint_id: string; files_restored: number }
  | { type: "context_update";     agent: string; key: string; scope: string }

// ── TUI → Bun ────────────────────────────────────────────────────────────────

export type TuiMessage =
  | { type: "ready" }
  | { type: "submit";               input: string }
  | { type: "suggestions_request";  query: string }
  | { type: "mode_change";          mode: string }
  | { type: "shell_execute";        command: string }
  | { type: "modal_submit";         command: string; values: Record<string, string> }
  | { type: "modal_cancel";         command: string }
  | { type: "info_modal_close" }
  | { type: "suspended" }
  | { type: "exit" }
  | { type: "quit" }
  | { type: "rollback"; checkpoint_id: string }

// ── Priority helpers ──────────────────────────────────────────────────────────

const CRITICAL_TYPES = new Set<BunMessage["type"]>([
  "init", "conflict_alert", "file_risk_update",
])
const LOW_TYPES = new Set<BunMessage["type"]>([
  "log_entry", "checkpoint_created", "checkpoint_rollback", "context_update",
])

export function messagePriority(msg: BunMessage): IpcPriority {
  if (CRITICAL_TYPES.has(msg.type)) return "critical"
  if (LOW_TYPES.has(msg.type))      return "low"
  return "normal"
}
