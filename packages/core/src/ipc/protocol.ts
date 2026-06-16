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

export interface WorkerDashboardFields {
  level?: number
  current_action?: string
  current_file?: string
  iteration_current?: number
  iteration_total?: number
  transversal?: boolean
}

export interface WorkerSnapshotEntry extends WorkerDashboardFields {
  name: string
  status: string
  detail?: string
  display_name?: string
  activity?: string
  token_count?: number
  replaces_worker?: string
}

export interface BlackboardEventMessage {
  timestamp: string
  agent: string
  event_type: string
  content: string
}

export interface DashboardLevelMessage {
  level: number
  label: string
  agents?: string[]
  status?: string
}

export interface DashboardCheckpointMessage {
  checkpoint_id: string
  description: string
  file_count: number
  agent: string
  time?: string
  tests_passed?: number
  tests_total?: number
}

export type BunMessage =
  // critical priority — user must see before agents proceed
  | { type: "init";            mode: string; provider: string; model: string; project_name: string; project_path: string; session_id: string; version: string; task_count: number; token_count: number; workers: string[] }
  | { type: "conflict_alert";  agent_a: string; agent_b: string; file: string; reason: string; severity: string; detail?: string | null }
  | { type: "conflict_resolved"; agent_a?: string; agent_b?: string; file?: string }
  | { type: "file_risk_update"; path: string; risk: string; operation: string; adr_ref: string | null; reason: string; agent: string; lines_added?: number; lines_removed?: number; task_id?: string }
  | { type: "forensic_alert";  worker: string; analysis: string; recommendation: string }
  | { type: "security_status_update"; status: string; findings?: number }
  | { type: "halt_state"; active: boolean; reason?: string; checkpoint_id?: string }
  // normal priority — live streaming output
  | { type: "history_append";  role: string; content: string; content_type?: string; agent?: string; timestamp?: string; task_id?: string }
  | { type: "status";          running: boolean; msg: string }
  | { type: "state_update";    new_mode?: string; new_provider?: string; new_model?: string; new_token_count?: number }
  | ({ type: "worker_update"; worker: string; phase: string; status: string; display_name?: string; activity?: string; task_id?: string; token_count?: number } & WorkerDashboardFields)
  | { type: "suggestions";     items: string[] }
  | { type: "quick_menu";      items: { label: string; cmd: string; desc: string }[] }
  | { type: "shell_output";    stdout: string; stderr: string; exit_code: number }
  | ({ type: "activity_update"; coordinator: string; phase: string; status: string; display_name?: string; activity?: string; task_id?: string; token_count?: number } & WorkerDashboardFields)
  | { type: "narrative_chunk"; coordinator: string; phase: string; content: string; content_type?: string; stream_id?: string; task_id?: string }
  | { type: "blackboard_event"; timestamp: string; agent: string; event_type: string; content: string }
  | { type: "metrics_update"; token_count?: number; cost?: string; elapsed_secs?: number }
  | {
      type: "dashboard_snapshot"
      workers?: WorkerSnapshotEntry[]
      blackboard_events?: BlackboardEventMessage[]
      conflicts?: { agent_a: string; agent_b: string; file?: string; reason: string; severity: string; detail?: string | null }[]
      levels?: DashboardLevelMessage[]
      checkpoints?: DashboardCheckpointMessage[]
      metrics?: { token_count?: number; cost?: string; elapsed_secs?: number }
      security?: { status: string; findings?: number }
      halt?: { active: boolean; reason?: string; checkpoint_id?: string }
    }
  | { type: "show_config_modal"; command: string; title: string; fields: ModalField[] }
  | { type: "show_info_modal"; title: string; content: string }
  | { type: "suspend" }
  | { type: "resume" }
  // low priority — informational, can lag
  | { type: "log_entry";          timestamp: string; level: string; source: string; message: string }
  | { type: "checkpoint_created"; checkpoint_id: string; description: string; file_count: number; agent: string; tests_passed?: number; tests_total?: number }
  | { type: "checkpoint_rollback"; checkpoint_id: string; files_restored: number }
  | { type: "context_update";     agent: string; key: string; scope: string }
  | { type: "adr_update";         path: string; title: string; content: string; status: string }
  | { type: "file_diff";          path: string; branch?: string; stats_added?: number; stats_removed?: number; chunks: { kind: string; text: string; old_line_no?: number; new_line_no?: number }[]; task_id?: string }
  | { type: "workers_snapshot";   workers: WorkerSnapshotEntry[] }
  | { type: "files_snapshot";     files: { path: string; risk: string; operation: string; agent: string }[] }
  | { type: "memory_update";      records_added: number; records_updated: number; records_deprecated: number }
  | { type: "librarian_progress"; status: "running" | "done"; records_written: number }
  | { type: "plan_update"; task_id: string; adr_title: string; adr_content: string; status: string; phases: { name: string; coordinator: string; description: string; depends_on: string[]; level: number; status: string }[]; risks: { severity: string; description: string }[] }
  | { type: "plan_approval_request" }
  | { type: "task_update"; task_id: string; title?: string; status: string; mode?: string; active_workers?: string[]; workspace_id?: string; workspace_path?: string; branch_name?: string; isolated?: boolean; integration_status?: string }

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
  | { type: "request_settings" }

// ── Priority helpers ──────────────────────────────────────────────────────────

const CRITICAL_TYPES = new Set<BunMessage["type"]>([
  "init", "conflict_alert", "conflict_resolved", "file_risk_update", "forensic_alert",
  "security_status_update", "halt_state",
])
const LOW_TYPES = new Set<BunMessage["type"]>([
  "log_entry", "checkpoint_created", "checkpoint_rollback", "context_update",
  "adr_update", "file_diff", "workers_snapshot", "files_snapshot",
  "memory_update", "librarian_progress", "dashboard_snapshot", "metrics_update",
])

export function messagePriority(msg: BunMessage): IpcPriority {
  if (CRITICAL_TYPES.has(msg.type)) return "critical"
  if (LOW_TYPES.has(msg.type))      return "low"
  return "normal"
}
