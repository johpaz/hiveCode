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
  /**
   * The active session changed — it was created lazily on the first message, or
   * switched with `/session resume`. The TUI clears the transcript and per-session
   * panels, then Bun re-sends the snapshot for the new id.
   */
  | { type: "session_changed"; session_id: string }
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
  /**
   * An agent started a tool call. Always paired with a `tool_done` carrying the
   * same `call_id`.
   *
   * Before this existed the TUI only received `current_action`, a free-text
   * string the backend filled with "ejecutando &lt;phase&gt;" — it never said
   * which tool was running or how long it would take.
   *
   * `args_summary` is truncated to 120 chars at the emitter: a 400 KB
   * `fs_read` payload cannot be rendered in a 30-cell column.
   */
  | {
      type: "tool_call"
      agent: string
      tool: string
      call_id: string
      args_summary: string
      /** Coarse activity, reusing the classification from `toolToBeeState()`. */
      bee_state: "thinking" | "searching" | "reading" | "writing" | "executing" | "done" | "error"
      task_id?: string
      at: number
    }
  /** A tool call finished, successfully or not. */
  | {
      type: "tool_done"
      agent: string
      tool: string
      call_id: string
      ok: boolean
      duration_ms: number
      result_summary: string
      task_id?: string
      at: number
    }
  /**
   * An agent cannot advance until something else happens.
   *
   * `reason` names the cause (`"jev_secuencial"`, `"subagente"`,
   * `"dependencia"`) rather than a sentence, so the UI can group waiting agents
   * by why they are stuck.
   */
  | {
      type: "esperando"
      agent: string
      esperando_a: string[]
      razon: string
      task_id?: string
      at: number
    }
  /**
   * La carga efectiva de un agente en este turno.
   *
   * No es el perfil declarado. JEV poda el conjunto y `search_knowledge` lo
   * amplía, así que la lista cambia en cada turno aunque no haya nada nuevo
   * que descubrir. Sin esto, la ficha del especialista anunciaría herramientas
   * que el agente ya no tiene.
   *
   * Llega por agente y **reemplaza** la anterior: cada turno emite la suya.
   */
  | {
      type: "carga_actual"
      agent: string
      tools: string[]
      skills: string[]
      /** De dónde salió el conjunto de herramientas. */
      origen: "perfil" | "jev_pruned"
      /** Skills en la carga mínima: disponibles sin descubrir nada. */
      minimal: string[]
      at: number
    }
  /**
   * A Jev decision was served and the caller is applying it.
   *
   * Jev (the decision plane) already emits this on the event bus
   * (`jev-decisions.ts` → `eventBus`) and nothing was subscribed. The TUI is
   * the first consumer: this is the "why" behind an agent's behaviour — what it
   * pruned, whether tools may run in parallel, which specialist it picked.
   *
   * Snake_case on the wire, like every other field here (`eventId` →
   * `event_id`). `summary` already arrives truncated to 160 chars.
   */
  | {
      type: "jev_decision"
      agent_id: string
      /** Which decision: "context" (prune + delegate), "parallel", "iteration". */
      kind: string
      summary: string
      saved_tokens: number
      cost_usd: number
      latency_ms: number
      /** Stable id, so the TUI can dedupe across a reconnect. */
      event_id: string
      totals: { decisions: number; saved_tokens: number; cost_usd: number }
    }
  /**
   * Availability of the decision plane.
   *
   * `off` means "not configured" and must not be rendered as an error;
   * `fallback` means it is cooling down after failures and deserves a warning.
   */
  | {
      type: "jev_status"
      state: "off" | "ready" | "fallback"
      last_error: string | null
      last_success_at: number | null
      totals: { decisions: number; saved_tokens: number; cost_usd: number }
    }
  | {
      type: "roster_snapshot"
      /**
       * The whole swarm, once. Sent on `init` and whenever an agent is created
       * or archived — never in the hot path.
       *
       * It is `describeSwarmCapabilities()` serialized: one roster, one read of
       * the capability fields. A second source would drift and the TUI would
       * advertise tools an agent does not have.
       *
       * `mcp[].state` travels with it so the UI can mark blocked specialists
       * before the first decision arrives, instead of waiting for `agentMcpOff`.
       */
      agentes: Array<{
        id: string
        /** Internal role: `backend`, `frontend`… what the bus and the logs use. */
        rol: string
        /** Visible alias: `Topo`, `Quetzal`… what the user reads. */
        alias: string
        funcion: string
        /** 0 = commander … 5 = on-demand. Same scale as the TUI's `AgentTier`. */
        nivel: number
        tools: string[]
        mcp: Array<{ name: string; state: "activo" | "disponible" | "apagado" }>
      }>
      mcp_servers: Array<{ id: string; name: string; tools: number; state: "activo" | "disponible" | "apagado" }>
    }
  | {
      type: "settings_data"
      // `models` = ids de los modelos llm habilitados de ese provider, para que la TUI
      // pueda ofrecer solo los del provider activo sin volver a consultar.
      // `has_key` se consulta en el keystore (no se inventa): la columna Key de la
      // TUI tiene que distinguir "clave guardada" de "falta API key".
      // `browser_login` marca los que hacen PKCE contra el backend y no usan clave.
      providers: Array<{ id: string; name: string; model: string; is_active: boolean; has_key: boolean; browser_login: boolean; models: string[] }>
      agents: Array<{ id: string; name: string; provider: string; model: string; effort: string; max_turns: number; max_input_tokens: number; max_output_tokens: number; max_cost_usd: number; permission_profile: string }>
      mcp: Array<{ id: string; name: string; url: string; enabled: boolean; has_headers: boolean }>
      skills: Array<{
        name: string
        description: string
        category: string
        active: boolean
        /** Tools que la skill documenta. Sin esto la TUI no puede decir si un
         *  agente puede usarla, y ofrecer una cuyas tools el agente no tiene es
         *  peor que no ofrecerla. */
        tools: string[]
        /** Roles que la recomiendan. El campo existía y nadie lo leía. */
        preferida_por: string[]
        /**
         * `isMinimalSkill()` del runtime: todas las tools de la skill están en la
         * carga mínima, así que está disponible sin descubrir nada.
         *
         * Lo calcula el backend con la misma función que usa el agente. Si la
         * TUI tuviera su propia regla, podría discrepar del runtime.
         */
        siempre_disponible: boolean
      }>
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
  /**
   * Activar el provider que el usuario ya eligió en el hub de settings de la TUI,
   * guardando su API key si viene.
   *
   * Sustituye a mandar `/provider set <id>` como `submit`: ese camino descartaba
   * el id y Bun volvía a mostrar el desplegable con TODOS los providers, así que
   * había que elegir dos veces el mismo. Aquí el id viaja explícito y el único
   * campo que se puede preguntar es la clave.
   */
  | { type: "provider_activate"; provider_id: string; api_key?: string }

// ── Priority helpers ──────────────────────────────────────────────────────────

const CRITICAL_TYPES = new Set<BunMessage["type"]>([
  "init", "conflict_alert", "conflict_resolved", "file_risk_update", "forensic_alert",
  "security_status_update", "halt_state", "review_verdict_update", "resume_available",
  // Drives a full transcript+panel reset, so it must not sit behind a backlog of
  // normal-priority history_append frames.
  "session_changed",
])
const LOW_TYPES = new Set<BunMessage["type"]>([
  "log_entry", "checkpoint_created", "checkpoint_rollback", "context_update",
  "adr_update", "file_diff", "workers_snapshot", "files_snapshot",
  "memory_update", "librarian_progress", "dashboard_snapshot", "metrics_update",
  // High-volume token streams: they must never delay a critical alert.
  "assistant_chunk", "thought_chunk",
  // Status flips are rare and tiny; a stale availability dot is worth nothing.
  "jev_status",
  // One snapshot of the whole swarm per agent created or archived. Rare enough
  // to be safe on the lagging channel, and it must never delay a critical alert.
  "roster_snapshot",
  // `jev_decision` is deliberately NOT here. It stays on `normal` because it is
  // the reasoning trail the user actually reads — the same thing Kimi surfaces
  // as "the logical chain of reasoning and decision-making". Putting it on
  // `low` would let it be dropped exactly when the swarm gets busy. The TUI
  // collapses and caps it on its own side instead of losing it in transit.
])

export function messagePriority(msg: BunMessage): IpcPriority {
  if (CRITICAL_TYPES.has(msg.type)) return "critical"
  if (LOW_TYPES.has(msg.type))      return "low"
  return "normal"
}
