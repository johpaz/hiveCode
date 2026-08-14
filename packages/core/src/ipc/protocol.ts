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
  /** Incremental answer token. Closed by `assistant_done`. */
  | { type: "assistant_chunk"; text: string; agent?: string; timestamp?: string }
  /** Ends the current `assistant_chunk` stream and commits it to history. */
  | { type: "assistant_done" }
  /** Live model reasoning. Shares the Bee panel with `narrative_chunk`, but the
   *  source differs: this is the model thinking, not coordinator phase narration. */
  | { type: "thought_chunk"; task_id?: string; coordinator: string; phase: string; content: string }
  /** Plan being drafted — rendered incrementally before the final `plan_update`. */
  | { type: "plan_draft_update"; task_id?: string; adr_title?: string; adr_content?: string; phases?: { name: string; coordinator: string; description: string; depends_on: string[]; level: number; status: string }[]; risks?: { severity: string; description: string }[] }
  /** Harness-level failure surfaced to the user. */
  | { type: "error"; message: string }
  | { type: "status";          running: boolean; msg: string }
  | { type: "state_update";    new_mode?: string; new_provider?: string; new_model?: string; new_token_count?: number }
  | ({ type: "worker_update"; worker: string; phase: string; status: string; display_name?: string; activity?: string; task_id?: string; token_count?: number } & WorkerDashboardFields)
  | { type: "quick_menu";      items: { label: string; cmd: string; desc: string }[] }
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
  | {
      // Field shape matches the pre-existing Rust ReviewVerdictUpdate contract
      // (reviewer/status/summary/observations/requested_changes/affected_files —
      // already rendered by review_layout.rs and exercised by tui-e2e.test.ts).
      // criteria/categories are additive: the structured acceptance checklist,
      // rendered when present, falling back to the observation-keyword heuristic
      // when absent (e.g. a reviewer model that didn't call submit_review_verdict).
      type: "review_verdict_update"
      reviewer?: string
      status: "aprobado" | "aprobado_con_observaciones" | "rechazado"
      summary: string
      observations?: string[]
      requested_changes?: string[]
      affected_files?: string[]
      criteria?: { description: string; met: boolean; evidence?: string }[]
      categories?: { name: string; status: "ok" | "warning" | "blocking"; detail?: string }[]
    }
  | { type: "resume_available"; task_id: string; checkpoint_id: string; reason: string }
  | { type: "phase_retry"; worker: string; attempt: number; max_attempts: number; reason: string }
  | {
      type: "settings_data"
      providers: Array<{ id: string; name: string; model: string; is_active: boolean; has_key: boolean }>
      agents: Array<{ id: string; name: string; provider: string; model: string; effort: string; max_turns: number; max_input_tokens: number; max_output_tokens: number; max_cost_usd: number; permission_profile: string }>
      mcp: Array<{ id: string; name: string; url: string; enabled: boolean; has_headers: boolean }>
      skills: Array<{ name: string; description: string; category: string; active: boolean }>
      github_connected: boolean
      github_repo: string | null
      telegram_active: boolean
    }

// ── TUI → Bun ────────────────────────────────────────────────────────────────

export type TuiMessage =
  | { type: "ready" }
  | { type: "submit";               input: string }
  | { type: "mode_change";          mode: string }
  | { type: "modal_submit";         command: string; values: Record<string, string> }
  | { type: "modal_cancel";         command: string }
  | { type: "info_modal_close" }
  /** Acknowledges `suspend` — the TUI released the terminal. */
  | { type: "suspended" }
  | { type: "exit" }
  | { type: "rollback"; checkpoint_id: string }
  | { type: "request_settings" }

// ── Priority helpers ──────────────────────────────────────────────────────────

const CRITICAL_TYPES = new Set<BunMessage["type"]>([
  "init", "conflict_alert", "conflict_resolved", "file_risk_update", "forensic_alert",
  "security_status_update", "halt_state", "review_verdict_update", "resume_available",
])
const LOW_TYPES = new Set<BunMessage["type"]>([
  "log_entry", "checkpoint_created", "checkpoint_rollback", "context_update",
  "adr_update", "file_diff", "workers_snapshot", "files_snapshot",
  "memory_update", "librarian_progress", "dashboard_snapshot", "metrics_update",
  // High-volume token streams: they must never delay a critical alert.
  "assistant_chunk", "thought_chunk",
])

export function messagePriority(msg: BunMessage): IpcPriority {
  if (CRITICAL_TYPES.has(msg.type)) return "critical"
  if (LOW_TYPES.has(msg.type))      return "low"
  return "normal"
}
