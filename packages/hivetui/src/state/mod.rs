
mod adr;
mod agent_graph;
mod checkpoint;
mod conflicts;
mod dashboard;
mod diff;
mod filemap;
mod harness;
mod history;
mod input;
mod logs;
mod jev;
mod modal;
mod panels;
mod roster;
mod skills;
mod plan;
mod review;
mod routing;
mod swarm;
mod session;
mod tasks;
mod thought;
mod workers;

pub use adr::{AdrEntry, AdrState};
pub use agent_graph::{AgentTier, all_edges, display_name as agent_display_name, edges_from, edges_to, tier_for};
pub use checkpoint::{Checkpoint, CheckpointState};
pub use conflicts::{AgentConflict, ConflictState};
pub use dashboard::{
    BlackboardEvent, DashboardLevel, DashboardLevelStatus, DashboardState, HaltState, ResumeInfo, SecurityState,
};
pub use diff::DiffState;
pub use crate::ipc::DiffLine;
pub use filemap::{FileEntry, FileMapState, RiskLevel};
pub use harness::{HarnessHealth, HarnessState};
pub use history::{HistoryEntry, HistoryState, Role};
pub use input::InputState;
pub use jev::{JevAvailability, JevDecision, JevState, JevTotals};
pub use logs::{LogEntry, LogState};
pub use modal::{
    ConfigModalState, InfoModalState, ModalAction, ModalField, ModalFieldKind, ModalState,
    PlanApprovalState, ProviderKeyState, ReviewAction, ReviewConfirmState, SettingsHubState,
    SettingsMcp, ModelRows, SettingsAgent, SettingsProvider, SettingsSkill, SettingsTab,
};
pub use panels::PanelLayoutState;
pub use plan::{ApiContract, PlanEntry, PlanPhase, PlanRisk, PlanState};
pub use review::{ReviewCategory, ReviewCriterion, ReviewState, ReviewVerdict};
pub use roster::{Loadout, McpRef, McpState, RosterAgent, RosterState, SkillSummary};
pub use skills::{SkillCard, SkillFit, SkillLibrary};
pub use routing::{LayoutRoutingState, LayoutStage};
pub use session::{ReplMode, SessionState, TabId};
pub use swarm::{BeeState, SwarmState, ToolCall, WaitingAgent};
pub use tasks::{TaskProjection, TaskProjectionState};
pub use thought::{StreamEntry, ThoughtChunk, ThoughtStreamState};
pub use workers::{Worker, WorkerState, WorkerStatus};

#[derive(Clone, Debug, PartialEq)]
pub struct Selection {
    pub anchor: (u16, u16),
    pub cursor: (u16, u16),
    pub active: bool,
}

impl Default for Selection {
    fn default() -> Self {
        Self {
            anchor: (0, 0),
            cursor: (0, 0),
            active: false,
        }
    }
}

#[derive(Debug, Default)]
pub struct AppState {
    pub session: SessionState,
    pub input: InputState,
    pub history: HistoryState,
    pub checkpoints: CheckpointState,
    pub workers: WorkerState,
    pub dashboard: DashboardState,
    pub filemap: FileMapState,
    pub thought: ThoughtStreamState,
    pub conflicts: ConflictState,
    pub adrs: AdrState,
    pub diff: DiffState,
    pub plan: PlanState,
    pub review: ReviewState,
    pub tasks: TaskProjectionState,
    pub harness: HarnessState,
    pub routing: LayoutRoutingState,
    pub modal: ModalState,
    pub logs: LogState,
    /// Plano de decisión: disponibilidad del oráculo y rastro de sus decisiones.
    pub jev: JevState,
    /// Telemetría del enjambre: tool calls en vuelo y agentes en espera.
    pub swarm: SwarmState,
    /// El enjambre: alias, rol, función, tools y estado de MCP por especialista.
    pub roster: RosterState,
    /// La carga efectiva por agente del último turno, indexada por id.
    pub loadout: std::collections::HashMap<String, Loadout>,
    /// Catálogo de habilidades, para `/habilidades` y la ficha.
    pub library: SkillLibrary,
    /// Sección activa del TALLER y su scroll.
    pub taller_section: crate::widgets::taller_layout::Section,
    pub taller_scroll: usize,
    /// Especialista abierto en la ficha, y su posición en la lista de secciones.
    pub ficha_agent: Option<String>,
    pub taller_agents_scroll: usize,
    pub github_connected: bool,
    pub github_repo: Option<String>,
    pub telegram_active: bool,
    pub panels: PanelLayoutState,
    /// Per-frame mouse hit regions emitted by renderer and consumed by controller.
    pub hit_map: crate::ui::HitMap,
    pub cursor_visible: bool,
    pub history_nav_mode: bool,
    pub history_hscroll: usize,
    pub history_hscroll_per_entry: std::collections::HashMap<usize, usize>,
    /// Scroll vertical de la vista Dashboard.
    pub dashboard_scroll: usize,
    /// Worker enfocado desde Dashboard/Code.
    pub focused_worker: Option<String>,
    /// Mensaje de la barra de estado inferior (viene de Status.msg de Bun).
    pub status_msg: String,
    /// true mientras Bun está procesando una petición.
    pub running: bool,
    /// Índice seleccionado en el popup de comandos `/`.
    pub command_popup_selected: usize,
    /// Campo enfocado dentro del modal de config.
    pub modal_focused: usize,
    /// Mensajes IPC pendientes de enviar (escritos por controller, drenados por app.rs).
    pub pending_ipc: Vec<crate::ipc::TuiMessage>,
    /// Controla si el panel derecho de workers está visible (toggle con /timeline).
    pub show_workers: bool,
    /// Tab activo en el layout principal (1-5).
    pub active_tab: TabId,
    /// Reloj en formato HH:MM:SS, actualizado en cada tick.
    pub clock: String,
    /// Costo acumulado de la sesión (ej. "$0.042").
    pub cost: String,
    /// Muestra la pantalla de bienvenida cuando no hay historial.
    pub show_welcome: bool,
    /// Contador de animación (0-7) que avanza cada tick para la bee del input.
    pub anim_tick: u8,
    /// Contador lento para el bob de la bee del welcome (avanza cada tick, ciclo 30 = 3.6s).
    pub slow_tick: u16,
    /// true cuando el usuario navegó manualmente (1-5); sólo `/auto` lo libera.
    pub tab_locked: bool,
    /// Text selection state for mouse drag-to-select copying.
    pub selection: Option<Selection>,
    /// Set by controller when user releases mouse after selection or presses Ctrl+Shift+C.
    /// The renderer reads this, extracts text from the canvas, copies to clipboard, and clears it.
    pub pending_copy_request: bool,
}

fn bun_event_name(msg: &crate::ipc::BunMessage) -> &'static str {
    use crate::ipc::BunMessage;
    match msg {
        BunMessage::Init { .. } => "init",
        BunMessage::AssistantChunk { .. } => "assistant_chunk",
        BunMessage::AssistantDone => "assistant_done",
        BunMessage::HistoryAppend { .. } => "history_append",
        BunMessage::Status { .. } => "status",
        BunMessage::StateUpdate { .. } => "state_update",
        BunMessage::SessionChanged { .. } => "session_changed",
        BunMessage::WorkerUpdate { .. } => "worker_update",
        BunMessage::ActivityUpdate { .. } => "activity_update",
        BunMessage::DashboardSnapshot { .. } => "dashboard_snapshot",
        BunMessage::BlackboardEvent { .. } => "blackboard_event",
        BunMessage::ConflictResolved { .. } => "conflict_resolved",
        BunMessage::ForensicAlert { .. } => "forensic_alert",
        BunMessage::SecurityStatusUpdate { .. } => "security_status_update",
        BunMessage::HaltState { .. } => "halt_state",
        BunMessage::MetricsUpdate { .. } => "metrics_update",
        BunMessage::CheckpointCreated { .. } => "checkpoint_created",
        BunMessage::FileRiskUpdate { .. } => "file_risk_update",
        BunMessage::ThoughtChunk { .. } => "thought_chunk",
        BunMessage::NarrativeChunk { .. } => "narrative_chunk",
        BunMessage::ShowConfigModal { .. } => "show_config_modal",
        BunMessage::ShowInfoModal { .. } => "show_info_modal",
        BunMessage::LogEntry { .. } => "log_entry",
        BunMessage::ConflictAlert { .. } => "conflict_alert",
        BunMessage::Error { .. } => "error",
        BunMessage::CheckpointRollback { .. } => "checkpoint_rollback",
        BunMessage::AdrUpdate { .. } => "adr_update",
        BunMessage::FileDiff { .. } => "file_diff",
        BunMessage::PlanUpdate { .. } => "plan_update",
        BunMessage::PlanDraftUpdate { .. } => "plan_draft_update",
        BunMessage::PlanApprovalRequest => "plan_approval_request",
        BunMessage::ReviewVerdictUpdate { .. } => "review_verdict_update",
        BunMessage::ResumeAvailable { .. } => "resume_available",
        BunMessage::PhaseRetry { .. } => "phase_retry",
        BunMessage::TaskUpdate { .. } => "task_update",
        BunMessage::WorkersSnapshot { .. } => "workers_snapshot",
        BunMessage::FilesSnapshot { .. } => "files_snapshot",
        BunMessage::QuickMenu { .. } => "quick_menu",
        BunMessage::Suspend => "suspend",
        BunMessage::Resume => "resume",
        BunMessage::ContextUpdate { .. } => "context_update",
        BunMessage::LibrarianProgress { .. } => "librarian_progress",
        BunMessage::MemoryUpdate { .. } => "memory_update",
        BunMessage::SettingsData { .. } => "settings_data",
        BunMessage::JevDecision { .. } => "jev_decision",
        BunMessage::JevStatus { .. } => "jev_status",
        BunMessage::ToolCall { .. } => "tool_call",
        BunMessage::ToolDone { .. } => "tool_done",
        BunMessage::Esperando { .. } => "esperando",
        BunMessage::RosterSnapshot { .. } => "roster_snapshot",
        BunMessage::CargaActual { .. } => "carga_actual",
        BunMessage::Unknown => "unknown",
    }
}

fn short_event_text(text: &str) -> String {
    crate::ui::text::ellipsize_cells(text.trim(), 80)
}

fn is_architect(name: &str) -> bool {
    matches!(name, "architecture" | "architect" | "arch") || name.contains("architect")
}

fn is_reviewer(name: &str) -> bool {
    matches!(name, "reviewer" | "code_reviewer") || name.contains("review")
}

fn is_bee(name: &str) -> bool {
    name == "bee"
}

fn is_focus_phase(phase: &str, activity: Option<&str>) -> bool {
    let phase = phase.to_ascii_lowercase();
    let activity = activity.unwrap_or("").to_ascii_lowercase();
    ["respond", "response", "fix", "idle", "answer"]
        .iter()
        .any(|needle| phase.contains(needle) || activity.contains(needle))
}

fn is_l2_worker(name: &str) -> bool {
    !name.starts_with("worker-")
        && !name.starts_with("tool-")
        && !name.starts_with("forensic:")
        && matches!(tier_for(name), AgentTier::Engineering)
}

fn status_to_worker_status(status: &str) -> WorkerStatus {
    match status {
        "running" | "thinking" | "draft" | "planning" => WorkerStatus::Running,
        "done"    => WorkerStatus::Done,
        "failed"  => WorkerStatus::Failed,
        "warn"    => WorkerStatus::Warn,
        _         => WorkerStatus::Waiting,
    }
}

fn map_api_contract(contract: crate::ipc::ApiContractIpc) -> ApiContract {
    ApiContract {
        name: contract.name,
        owner: contract.owner,
        method: contract.method,
        path: contract.path,
        request: contract.request,
        response: contract.response,
        status: contract.status,
    }
}

fn map_blackboard_event(event: crate::ipc::BlackboardEventIpc) -> BlackboardEvent {
    BlackboardEvent {
        timestamp: event.timestamp,
        agent: event.agent,
        event_type: event.event_type,
        content: event.content,
    }
}

fn map_dashboard_level(level: crate::ipc::DashboardLevelIpc) -> DashboardLevel {
    DashboardLevel {
        level: level.level,
        label: level.label,
        agents: level.agents,
        status: DashboardLevelStatus::from_str(&level.status),
    }
}

fn map_checkpoint(checkpoint: crate::ipc::CheckpointIpc) -> Checkpoint {
    Checkpoint {
        id: checkpoint.id,
        description: checkpoint.description,
        file_count: checkpoint.file_count,
        agent: checkpoint.agent,
        time: checkpoint.time.unwrap_or_default(),
        tests_passed: checkpoint.tests_passed.unwrap_or(0),
        tests_total: checkpoint.tests_total.unwrap_or(0),
    }
}

fn map_conflict(conflict: crate::ipc::AgentConflictIpc) -> AgentConflict {
    AgentConflict {
        agent_a: conflict.agent_a,
        agent_b: conflict.agent_b,
        path: conflict.file.unwrap_or_default(),
        reason: conflict.reason,
        severity: conflict.severity,
        detail: conflict.detail,
    }
}

fn dashboard_levels_from_phases(phases: &[PlanPhase]) -> Vec<DashboardLevel> {
    let mut levels: Vec<DashboardLevel> = Vec::new();
    for phase in phases {
        if let Some(existing) = levels.iter_mut().find(|level| level.level == phase.level) {
            existing.agents.push(phase.coordinator.clone());
            if phase.status == "running" {
                existing.status = DashboardLevelStatus::Active;
            } else if phase.status == "completed" && existing.status != DashboardLevelStatus::Active {
                existing.status = DashboardLevelStatus::Done;
            }
            continue;
        }
        levels.push(DashboardLevel {
            level: phase.level,
            label: phase.name.clone(),
            agents: vec![phase.coordinator.clone()],
            status: DashboardLevelStatus::from_str(&phase.status),
        });
    }
    levels.sort_by_key(|level| level.level);
    levels
}

impl AppState {
    fn active_execution_workers(&self) -> Vec<&str> {
        let Some(task_id) = self.tasks.active_task_id.as_deref() else {
            return Vec::new();
        };
        let Some(task) = self.tasks.tasks.iter().find(|task| task.task_id == task_id) else {
            return Vec::new();
        };
        let active_level = task
            .active_workers
            .iter()
            .filter_map(|name| {
                self.workers.workers.iter().find(|worker| worker.name == *name)
            })
            .filter(|worker| is_l2_worker(&worker.name) && !worker.transversal)
            .filter_map(|worker| worker.level)
            .min();

        task.active_workers
            .iter()
            .filter_map(|name| {
                if !is_l2_worker(name) {
                    return None;
                }
                let worker = self.workers.workers.iter().find(|worker| worker.name == *name);
                if worker.is_some_and(|worker| worker.transversal) {
                    return None;
                }
                if active_level.is_some()
                    && worker.and_then(|worker| worker.level).is_some()
                    && worker.and_then(|worker| worker.level) != active_level
                {
                    return None;
                }
                Some(name.as_str())
            })
            .collect()
    }

    fn recommend_layout(&mut self, tab: TabId, stage: LayoutStage, reason: impl Into<String>) {
        self.routing.recommend(tab, stage, reason);
        if self.tab_locked || self.is_user_busy() {
            // El usuario está leyendo o escribiendo: no le movemos la pantalla.
            // El tabbar marca el tab recomendado y el footer explica por qué.
            return;
        }
        let changed = self.active_tab != self.routing.recommended_tab;
        if !changed {
            return;
        }
        self.active_tab = self.routing.recommended_tab;
        self.history_nav_mode = false;
        self.history_hscroll = 0;
    }

    /// El usuario demostró intención de quedarse donde está: está componiendo un
    /// mensaje, navegando el historial, o scrolleó hacia atrás para leer.
    fn is_user_busy(&self) -> bool {
        !self.input.value().is_empty() || self.history_nav_mode || self.history.scroll > 0
    }

    /// True cuando el auto-routing quiere otra pestaña pero no la forzamos.
    pub fn pending_layout_suggestion(&self) -> Option<TabId> {
        (self.active_tab != self.routing.recommended_tab).then_some(self.routing.recommended_tab)
    }

    pub fn resume_auto_layout(&mut self) {
        self.tab_locked = false;
        self.active_tab = self.routing.recommended_tab;
        self.history_nav_mode = false;
        self.history_hscroll = 0;
    }

    pub fn tick_layout_transition(&mut self) {
        self.routing.tick();
    }

    fn route_after_worker_activity(&mut self, worker: &str, phase: &str, status: &str, activity: Option<&str>) {
        if is_bee(worker) {
            let reason = if is_focus_phase(phase, activity) {
                "Bee responde -> Focus"
            } else {
                "Bee clasifica solicitud -> Focus"
            };
            self.recommend_layout(TabId::Mesa, LayoutStage::Classifying, reason);
            return;
        }

        if is_architect(worker) && matches!(status, "running" | "thinking" | "draft" | "planning") {
            self.recommend_layout(TabId::Plan, LayoutStage::Planning, "Architect activo -> Plan");
            return;
        }

        if is_reviewer(worker) && (self.session.mode == ReplMode::Approval || status == "done") {
            self.recommend_layout(TabId::Review, LayoutStage::Reviewing, "Reviewer completo -> Review");
            return;
        }

        let execution_workers = self.active_execution_workers();
        if execution_workers.len() >= 2 {
            self.recommend_layout(
                TabId::Swarm,
                LayoutStage::Executing,
                format!("{} workers activos -> Dashboard", execution_workers.len()),
            );
            return;
        }

        if status == "running" && is_l2_worker(worker) && !execution_workers.is_empty() {
            self.recommend_layout(TabId::Code, LayoutStage::Executing, "1 worker activo -> Code");
            return;
        }
    }

    fn route_after_diff(&mut self) {
        if self.session.mode == ReplMode::Plan {
            return;
        }
        if self.active_execution_workers().len() >= 2 {
            self.recommend_layout(TabId::Swarm, LayoutStage::Executing, "workers paralelos -> Dashboard");
        } else {
            self.recommend_layout(TabId::Code, LayoutStage::Executing, "diff activo -> Code");
        }
    }

    fn note_task_worker(&mut self, task_id: Option<String>, worker: &str, status: &str) {
        let Some(task_id) = task_id.filter(|task_id| !task_id.trim().is_empty()) else {
            return;
        };
        self.tasks.mark_worker(task_id, worker.to_string(), status);
        self.session.task_count = self.session.task_count.max(self.tasks.tasks.len() as u32);
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert_worker(
        &mut self,
        name: String,
        phase: Option<String>,
        status: WorkerStatus,
        display_name: Option<String>,
        activity: Option<String>,
        token_count: Option<u64>,
        level: Option<u32>,
        current_action: Option<String>,
        current_file: Option<String>,
        iteration_current: Option<u32>,
        iteration_total: Option<u32>,
        transversal: Option<bool>,
        replaces_worker: Option<String>,
    ) {
        let action = current_action
            .or_else(|| activity.clone())
            .or_else(|| phase.clone());
        if let Some(w) = self.workers.workers.iter_mut().find(|w| w.name == name) {
            w.status = status;
            if let Some(phase) = phase {
                w.detail = Some(phase);
            }
            if let Some(display_name) = display_name {
                w.display_name = display_name;
            }
            if let Some(activity) = activity {
                w.activity = Some(activity);
            }
            if let Some(tokens) = token_count {
                w.token_count = tokens;
            }
            if level.is_some() {
                w.level = level;
            }
            if action.is_some() {
                w.current_action = action;
            }
            if current_file.is_some() {
                w.current_file = current_file;
            }
            if iteration_current.is_some() {
                w.iteration_current = iteration_current;
            }
            if iteration_total.is_some() {
                w.iteration_total = iteration_total;
            }
            if let Some(transversal) = transversal {
                w.transversal = transversal;
            }
            if replaces_worker.is_some() {
                w.replaces_worker = replaces_worker;
            }
        } else {
            let mut worker = Worker::new(name.clone());
            worker.status = status;
            // Sin `display_name` del backend, caer en el **nombre crudo** saltaría
            // la tabla de alias y mostraría "@BACKEND" en vez de "@TOPO". El
            // invariante es que `display_name` siempre sea legible.
            worker.display_name = display_name.unwrap_or_else(|| agent_display_name(&name));
            worker.detail = phase;
            worker.activity = activity;
            worker.token_count = token_count.unwrap_or(0);
            worker.level = level;
            worker.current_action = action;
            worker.current_file = current_file;
            worker.iteration_current = iteration_current;
            worker.iteration_total = iteration_total;
            worker.transversal = transversal.unwrap_or(false);
            worker.replaces_worker = replaces_worker;
            self.workers.workers.push(worker);
        }
    }

    pub fn apply_message(&mut self, msg: crate::ipc::BunMessage) {
        use crate::ipc::BunMessage;
        self.harness.record_event(bun_event_name(&msg));

        match msg {
            // ── Inicialización ─────────────────────────────────────────────────
            BunMessage::Init { session_id, workers, mode, provider, model,
                               project_name, project_path, version,
                               task_count, token_count } => {
                self.session.session_id = session_id;
                if let Some(m) = mode {
                    self.session.mode = ReplMode::from(m.as_str());
                    // Siempre iniciar en Focus — el modo sólo cambia el tab durante
                    // una tarea activa (ActivityUpdate/StateUpdate), no al arrancar.
                    if !self.tab_locked {
                        self.active_tab = TabId::Mesa;
                    }
                }
                if let Some(p) = provider    { self.session.provider     = p; }
                if let Some(m) = model       { self.session.model        = m; }
                if let Some(n) = project_name{ self.session.project_name = n; }
                if let Some(p) = project_path{ self.session.project_path = p; }
                if let Some(v) = version     { self.session.version      = v; }
                if let Some(t) = task_count  { self.session.task_count   = t; }
                if let Some(t) = token_count { self.session.token_count  = t; }
                self.session.workers = workers.clone();
                for name in workers {
                    if !self.workers.workers.iter().any(|w| w.name == name) {
                        self.workers.workers.push(Worker::new(name));
                    }
                }
            }

            // ── Respuesta del agente ───────────────────────────────────────────
            BunMessage::AssistantChunk { text, agent, timestamp } => {
                if let Some(agent_name) = agent.as_ref().filter(|agent| !agent.trim().is_empty()) {
                    self.harness.last_agent = Some(agent_name.clone());
                }
                match self.history.entries.last_mut() {
                    Some(e) if e.role == Role::Assistant => e.content.push_str(&text),
                    _ => {
                        self.history.entries.push(HistoryEntry {
                            role: Role::Assistant,
                            content: text,
                            agent,
                            timestamp,
                        });
                        // Solo al abrir un turno nuevo. Resetear en cada chunk impedía
                        // leer una respuesta larga mientras se está generando.
                        self.history.scroll = 0;
                    }
                }
                self.history.selected = Some(self.history.entries.len().saturating_sub(1));
            }
            BunMessage::AssistantDone => {
                self.running = false;
                if !self.harness.approval_pending {
                    self.harness.active_task_status = Some("idle".to_string());
                }
                // El turno termina donde el usuario lo dejó; no lo devolvemos al inicio.
                if self.session.mode == ReplMode::Plan && self.plan.current.is_some() {
                    self.recommend_layout(TabId::Plan, LayoutStage::Planning, "plan listo -> Plan");
                } else {
                    self.recommend_layout(TabId::Mesa, LayoutStage::Completed, "tarea completa -> Focus");
                }
            }
            // Protocolo legado: respuesta completa en un mensaje
            BunMessage::HistoryAppend { role, content, agent, timestamp, .. } => {
                let r = Role::from(role.as_str());
                if let Some(agent_name) = agent.as_ref().filter(|agent| !agent.trim().is_empty()) {
                    self.harness.last_agent = Some(agent_name.clone());
                }
                self.history.entries.push(HistoryEntry { role: r, content, agent, timestamp });
                self.history.scroll = 0;
                self.history.selected = Some(self.history.entries.len().saturating_sub(1));
                if r == Role::Assistant {
                    // La respuesta llegó → detener live-activity y mostrarla ya.
                    // No esperar a Status{running:false}; tui-launcher los envía en orden
                    // pero queremos el cambio de estado en el mismo frame.
                    self.running = false;
                    if self.session.mode == ReplMode::Plan && self.plan.current.is_some() {
                        self.recommend_layout(TabId::Plan, LayoutStage::Planning, "plan listo -> Plan");
                    } else {
                        self.recommend_layout(TabId::Mesa, LayoutStage::Completed, "respuesta completa -> Focus");
                    }
                }
            }

            // ── Estado de sesión ───────────────────────────────────────────────
            BunMessage::Status { running, msg } => {
                let was_running = self.running;
                self.running = running;
                self.status_msg = msg;
                if !self.harness.approval_pending {
                    self.harness.active_task_status = Some(if running { "running" } else { "idle" }.to_string());
                }
                // Cuando la tarea termina (running: true → false) ir a Focus igual que AssistantDone.
                // Esto maneja el protocolo del tui-launcher que usa Status en vez de AssistantDone.
                if was_running && !running {
                    if self.session.mode == ReplMode::Plan && self.plan.current.is_some() {
                        self.recommend_layout(TabId::Plan, LayoutStage::Planning, "plan listo -> Plan");
                    } else {
                        self.recommend_layout(TabId::Mesa, LayoutStage::Completed, "tarea finalizada -> Focus");
                    }
                }
            }
            BunMessage::StateUpdate { new_mode, new_provider, new_model, new_token_count } => {
                if let Some(m) = new_mode {
                    self.session.mode = ReplMode::from(m.as_str());
                    if self.session.mode == ReplMode::Plan {
                        self.plan.current = None;
                        self.plan.scroll = 0;
                    }
                    self.recommend_layout(TabId::Mesa, LayoutStage::Idle, "modo actualizado -> Focus");
                }
                if let Some(p) = new_provider { self.session.provider = p; }
                if let Some(m) = new_model { self.session.model = m; }
                if let Some(t) = new_token_count { self.session.token_count = t; }
            }
            BunMessage::SessionChanged { session_id } => {
                // La sesión activa cambió (creada lazy al primer mensaje, o
                // cambiada con `/session resume`). Todo lo que cuelga de la
                // sesión anterior se suelta; Bun reenvía el snapshot de la
                // nueva justo después de este mensaje.
                self.history = Default::default();
                self.checkpoints = Default::default();
                self.tasks = Default::default();
                self.conflicts = Default::default();
                self.thought = Default::default();
                self.diff = Default::default();
                self.plan = Default::default();
                self.dashboard.resume = None;
                self.session.session_id = session_id;
            }

            // ── Workers ────────────────────────────────────────────────────────
            BunMessage::WorkerUpdate {
                task_id,
                worker,
                phase,
                status,
                display_name,
                activity,
                token_count,
                level,
                current_action,
                current_file,
                iteration_current,
                iteration_total,
                transversal,
            } => {
                self.harness.last_agent = Some(worker.clone());
                self.harness.last_phase = Some(phase.clone());
                if let Some(activity_text) = activity.as_ref().filter(|text| !text.trim().is_empty()) {
                    self.harness.last_activity = Some(short_event_text(activity_text));
                }
                if let Some(task_id) = task_id.as_ref().filter(|task_id| !task_id.trim().is_empty()) {
                    self.harness.active_task_id = Some(task_id.clone());
                    self.harness.active_task_status = Some(status.clone());
                }
                let wstatus = status_to_worker_status(&status);
                self.upsert_worker(
                    worker.clone(),
                    Some(phase.clone()),
                    wstatus,
                    display_name,
                    activity.clone(),
                    token_count,
                    level,
                    current_action,
                    current_file,
                    iteration_current,
                    iteration_total,
                    transversal,
                    None,
                );
                self.note_task_worker(task_id, &worker, &status);
                self.route_after_worker_activity(&worker, &phase, &status, activity.as_deref());
            }
            // Legado: activity_update → actualiza coordinator activo
            BunMessage::ActivityUpdate {
                task_id,
                coordinator,
                phase,
                status,
                display_name,
                activity,
                token_count,
                level,
                current_action,
                current_file,
                iteration_current,
                iteration_total,
                transversal,
            } => {
                self.harness.last_agent = Some(coordinator.clone());
                self.harness.last_phase = Some(phase.clone());
                if let Some(activity_text) = activity.as_ref().filter(|text| !text.trim().is_empty()) {
                    self.harness.last_activity = Some(short_event_text(activity_text));
                }
                if let Some(task_id) = task_id.as_ref().filter(|task_id| !task_id.trim().is_empty()) {
                    self.harness.active_task_id = Some(task_id.clone());
                    self.harness.active_task_status = Some(status.clone());
                }
                self.workers.active_coordinator = coordinator.clone();
                self.workers.active_phase = phase.clone();
                self.workers.activity_status = status.clone();
                let wstatus = status_to_worker_status(&status);
                self.upsert_worker(
                    coordinator.clone(),
                    Some(phase.clone()),
                    wstatus,
                    display_name,
                    activity.clone(),
                    token_count,
                    level,
                    current_action,
                    current_file,
                    iteration_current,
                    iteration_total,
                    transversal,
                    None,
                );
                self.note_task_worker(task_id, &coordinator, &status);
                self.route_after_worker_activity(&coordinator, &phase, &status, activity.as_deref());
            }

            BunMessage::DashboardSnapshot {
                workers,
                blackboard_events,
                conflicts,
                levels,
                checkpoints,
                metrics,
                security,
                halt,
            } => {
                for w in workers {
                    let status = status_to_worker_status(&w.status);
                    self.upsert_worker(
                        w.name.clone(),
                        w.detail.clone(),
                        status,
                        w.display_name,
                        w.activity.clone(),
                        w.token_count,
                        w.level,
                        w.current_action,
                        w.current_file,
                        w.iteration_current,
                        w.iteration_total,
                        w.transversal,
                        w.replaces_worker,
                    );
                }
                self.dashboard.blackboard_events =
                    blackboard_events.into_iter().map(map_blackboard_event).collect();
                self.conflicts.entries = conflicts.into_iter().map(map_conflict).collect();
                self.dashboard.levels = levels.into_iter().map(map_dashboard_level).collect();
                if !checkpoints.is_empty() {
                    self.checkpoints.entries = checkpoints.into_iter().map(map_checkpoint).collect();
                }
                if let Some(metrics) = metrics {
                    if let Some(tokens) = metrics.token_count {
                        self.session.token_count = tokens;
                    }
                    if let Some(cost) = metrics.cost {
                        self.cost = cost;
                    }
                    self.dashboard.metrics.elapsed_secs = metrics.elapsed_secs;
                }
                if let Some(security) = security {
                    self.dashboard.security.status = security.status;
                    self.dashboard.security.findings = security.findings.unwrap_or(0);
                }
                if let Some(halt) = halt {
                    self.dashboard.halt.active = halt.active;
                    self.dashboard.halt.reason = halt.reason;
                    self.dashboard.halt.checkpoint_id = halt.checkpoint_id;
                }
                // Los snapshots hidratan la UI, pero nunca deciden navegación.
            }
            BunMessage::LibrarianProgress { status, records_written } => {
                let content = if status == "done" {
                    format!("memoria destilada: {records_written} registros")
                } else {
                    "destilando memoria del proyecto".to_string()
                };
                self.harness.last_agent = Some("librarian".to_string());
                self.harness.last_phase = Some(status.clone());
                self.harness.last_activity = Some(short_event_text(&content));
                self.dashboard.push_blackboard_event(BlackboardEvent {
                    timestamp: self.clock.clone(),
                    agent: "librarian".to_string(),
                    event_type: "LIBRARIAN".to_string(),
                    content,
                });
            }
            BunMessage::MemoryUpdate { records_added, records_updated, records_deprecated } => {
                let content = format!(
                    "memoria: +{records_added} nuevos, {records_updated} actualizados, {records_deprecated} obsoletos"
                );
                self.harness.last_activity = Some(short_event_text(&content));
                self.dashboard.push_blackboard_event(BlackboardEvent {
                    timestamp: self.clock.clone(),
                    agent: "librarian".to_string(),
                    event_type: "MEMORY".to_string(),
                    content,
                });
            }
            BunMessage::BlackboardEvent { timestamp, agent, event_type, content } => {
                self.dashboard.push_blackboard_event(BlackboardEvent {
                    timestamp,
                    agent,
                    event_type,
                    content,
                });
            }
            BunMessage::ConflictResolved { agent_a, agent_b, file } => {
                self.conflicts.entries.retain(|conflict| {
                    let same_agents = match (agent_a.as_deref(), agent_b.as_deref()) {
                        (Some(a), Some(b)) => {
                            (conflict.agent_a == a && conflict.agent_b == b)
                                || (conflict.agent_a == b && conflict.agent_b == a)
                        }
                        (Some(a), None) | (None, Some(a)) => {
                            conflict.agent_a == a || conflict.agent_b == a
                        }
                        (None, None) => false,
                    };
                    let same_file = file
                        .as_deref()
                        .map(|path| conflict.path == path)
                        .unwrap_or(true);
                    !(same_agents && same_file)
                });
                self.dashboard.push_blackboard_event(BlackboardEvent {
                    timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                    agent: "bee".to_string(),
                    event_type: "RESOLVED".to_string(),
                    content: "conflicto resuelto".to_string(),
                });
            }
            BunMessage::ForensicAlert { worker, analysis, recommendation } => {
                let forensic_name = format!("forensic:{worker}");
                self.upsert_worker(
                    forensic_name,
                    Some("forensic".to_string()),
                    WorkerStatus::Warn,
                    Some(format!("ForensicAgent -> {}", agent_display_name(&worker))),
                    Some(recommendation.clone()),
                    None,
                    None,
                    Some("analizando causa raiz".to_string()),
                    None,
                    None,
                    None,
                    Some(false),
                    Some(worker),
                );
                self.dashboard.push_blackboard_event(BlackboardEvent {
                    timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                    agent: "forensic".to_string(),
                    event_type: "FORENSIC".to_string(),
                    content: short_event_text(&analysis),
                });
                self.recommend_layout(TabId::Swarm, LayoutStage::Failed, "análisis forense -> Dashboard");
            }
            BunMessage::SecurityStatusUpdate { status, findings } => {
                self.dashboard.security.status = status;
                self.dashboard.security.findings = findings.unwrap_or(self.dashboard.security.findings);
            }
            BunMessage::HaltState { active, reason, checkpoint_id } => {
                self.dashboard.halt.active = active;
                self.dashboard.halt.reason = reason.clone();
                self.dashboard.halt.checkpoint_id = checkpoint_id;
                if active {
                    self.dashboard.push_blackboard_event(BlackboardEvent {
                        timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                        agent: "bee".to_string(),
                        event_type: "HALT".to_string(),
                        content: reason.unwrap_or_else(|| "HALT emitido".to_string()),
                    });
                    self.recommend_layout(TabId::Swarm, LayoutStage::Failed, "HALT activo -> Dashboard");
                }
            }
            BunMessage::MetricsUpdate { token_count, cost, elapsed_secs } => {
                if let Some(tokens) = token_count {
                    self.session.token_count = tokens;
                }
                if let Some(cost) = cost {
                    self.cost = cost;
                }
                self.dashboard.metrics.elapsed_secs = elapsed_secs.or(self.dashboard.metrics.elapsed_secs);
            }

            // ── Checkpoints ────────────────────────────────────────────────────
            BunMessage::CheckpointCreated { id, description, file_count, agent, tests_passed, tests_total } => {
                self.harness.last_agent = Some(agent.clone());
                let time = chrono::Local::now().format("%H:%M").to_string();
                self.checkpoints.push(Checkpoint {
                    id,
                    description,
                    file_count,
                    agent,
                    time,
                    tests_passed: tests_passed.unwrap_or(0),
                    tests_total: tests_total.unwrap_or(0),
                });
            }

            // ── Mapa de riesgo ─────────────────────────────────────────────────
            BunMessage::FileRiskUpdate { path, risk, operation, agent, adr_ref, lines_added, lines_removed, .. } => {
                self.harness.last_agent = Some(agent.clone());
                self.harness.active_workspace_status = Some(operation.clone());
                let risk_level = match risk.as_str() {
                    "medium"   => RiskLevel::Medium,
                    "high"     => RiskLevel::High,
                    "critical" => RiskLevel::Critical,
                    _          => RiskLevel::Low,
                };
                if let Some(entry) = self.filemap.entries.iter_mut().find(|e| e.path == path) {
                    entry.risk = risk_level;
                    entry.operation = operation;
                    entry.agent = agent;
                    entry.adr_ref = adr_ref;
                    entry.lines_added = lines_added.unwrap_or(0);
                    entry.lines_removed = lines_removed.unwrap_or(0);
                } else {
                    self.filemap.entries.push(FileEntry {
                        path,
                        risk: risk_level,
                        operation,
                        agent,
                        adr_ref,
                        lines_added: lines_added.unwrap_or(0),
                        lines_removed: lines_removed.unwrap_or(0),
                    });
                }
            }

            // ── Stream de narración ─────────────────────────────────────────────
            // `thought_chunk` y `narrative_chunk` entran al MISMO array: antes
            // se funnelizaban indistintamente y `content_type` se parseaba para
            // tirarse. `push_chunk` los separa en Razonamiento y Narracion.
            BunMessage::ThoughtChunk { task_id, coordinator, phase, content } => {
                self.harness.last_agent = Some(coordinator.clone());
                self.harness.last_phase = Some(phase.clone());
                self.harness.last_activity = Some(short_event_text(&content));
                self.thought.push_chunk(ThoughtChunk { coordinator, phase, content });
                if let Some(chunk) = self.thought.chunks.last() {
                    let coordinator = chunk.coordinator.clone();
                    let phase = chunk.phase.clone();
                    let content = chunk.content.clone();
                    self.note_task_worker(task_id, &coordinator, "thinking");
                    self.route_after_worker_activity(&coordinator, &phase, "thinking", Some(&content));
                }
            }
            BunMessage::NarrativeChunk { task_id, coordinator, phase, content, .. } => {
                self.harness.last_agent = Some(coordinator.clone());
                self.harness.last_phase = Some(phase.clone());
                self.harness.last_activity = Some(short_event_text(&content));
                self.thought.push_chunk(ThoughtChunk { coordinator, phase, content });
                if let Some(chunk) = self.thought.chunks.last() {
                    let coordinator = chunk.coordinator.clone();
                    let phase = chunk.phase.clone();
                    let content = chunk.content.clone();
                    self.note_task_worker(task_id, &coordinator, "thinking");
                    self.route_after_worker_activity(&coordinator, &phase, "thinking", Some(&content));
                }
            }
            BunMessage::Unknown => {
                // Mensaje de tipo desconocido — ignorar silenciosamente
            }

            // ── Modales ────────────────────────────────────────────────────────
            BunMessage::ShowConfigModal { command, title, fields } => {
                use crate::ipc::IpcModalField;
                let modal_fields: Vec<ModalField> = fields.into_iter().map(|f: IpcModalField| {
                    let kind = match (f.secret.unwrap_or(false), f.field_type.as_deref()) {
                        (true, _)           => ModalFieldKind::Secret,
                        (_, Some("select")) => ModalFieldKind::Select,
                        _                   => ModalFieldKind::Text,
                    };
                    ModalField {
                        key: f.key,
                        label: f.label,
                        kind,
                        required: f.required.unwrap_or(false),
                        default_value: f.default_value.clone(),
                        options: f.options,
                    }
                }).collect();
                let values: Vec<String> = modal_fields.iter()
                    .map(|f| {
                        if let Some(v) = &f.default_value {
                            v.clone()
                        } else if f.kind == ModalFieldKind::Select {
                            // Select sin default → primera opción disponible
                            f.options.as_ref().and_then(|o| o.first()).cloned().unwrap_or_default()
                        } else {
                            String::new()
                        }
                    })
                    .collect();
                let n = modal_fields.len();
                self.modal = ModalState::Config(ConfigModalState {
                    command,
                    title,
                    fields: modal_fields,
                    values,
                    cursors: vec![0; n],
                    focused: 0,
                    errors: vec![false; n],
                    // Los modales de Bun se responden con `ModalSubmit`; la
                    // acción local y el hub al que volver son cosa de la TUI.
                    ..Default::default()
                });
                self.modal_focused = 0;
            }
            BunMessage::ShowInfoModal { title, content } => {
                self.modal = ModalState::Info(InfoModalState { title, content, scroll: 0 });
            }

            // ── Settings Hub ───────────────────────────────────────────────────
            BunMessage::SettingsData { providers, agents, mcp, skills, github_connected, github_repo, telegram_active } => {
                if let ModalState::Settings(hub) = &mut self.modal {
                    hub.providers = providers.into_iter().map(|p| SettingsProvider {
                        id: p.id, name: p.name, model: p.model,
                        is_active: p.is_active, has_key: p.has_key,
                        browser_login: p.browser_login,
                        models: p.models,
                    }).collect();
                    hub.agents = agents.into_iter().map(|a| SettingsAgent {
                        id: a.id, name: a.name, provider: a.provider, model: a.model,
                        effort: a.effort, max_turns: a.max_turns,
                        max_input_tokens: a.max_input_tokens,
                        max_output_tokens: a.max_output_tokens,
                        max_cost_usd: a.max_cost_usd,
                        permission_profile: a.permission_profile,
                    }).collect();
                    hub.mcp = mcp.into_iter().map(|m| SettingsMcp {
                        id: m.id, name: m.name, url: m.url, enabled: m.enabled, has_headers: m.has_headers,
                    }).collect();
                    hub.skills = skills.into_iter().map(|s| SettingsSkill {
                        name: s.name, description: s.description,
                        category: s.category, active: s.active,
                    }).collect();
                    hub.github_connected = github_connected;
                    hub.github_repo = github_repo;
                    hub.telegram_active = telegram_active;
                    hub.loading = false;
                }
            }

            // ── Logs ───────────────────────────────────────────────────────────
            BunMessage::LogEntry { timestamp, level, source, message } => {
                self.logs.entries.push(LogEntry { timestamp, level, source, message });
                if self.logs.entries.len() > self.logs.capacity {
                    self.logs.entries.remove(0);
                }
            }

            // ── Jev: plano de decisión ──────────────────────────────────────────
            // Antes esto se calculaba en el backend y se tiraba: nadie estaba
            // suscrito al event bus. Acá queda el rastro.
            BunMessage::JevDecision { agent_id, kind, summary, saved_tokens,
                                      cost_usd, latency_ms, event_id, totals } => {
                self.jev.totals = JevTotals::from(&totals);
                // La decisión va también al stream: es el "por qué" del agente,
                // y en MESA es lo queKimi llama la cadena de razonamiento.
                self.thought.push(StreamEntry::Decision {
                    agent: agent_id.clone(),
                    ts: 0,
                    kind: kind.clone(),
                    summary: summary.clone(),
                    saved_tokens,
                });
                self.jev.record(JevDecision {
                    agent_id,
                    kind,
                    summary,
                    saved_tokens,
                    cost_usd,
                    latency_ms,
                    event_id,
                    availability: self.jev.availability,
                });
            }
            BunMessage::JevStatus { state, last_error, last_success_at, totals } => {
                self.jev.set_availability(
                    JevAvailability::from_str(&state),
                    last_error,
                    last_success_at,
                    JevTotals::from(&totals),
                );
                // Recovered: the oracle was cooling down and now answers again.
                if self.jev.availability == JevAvailability::Ready {
                    self.jev.last_error = None;
                }
            }

            // ── Telemetría del enjambre ─────────────────────────────────────────
            BunMessage::ToolCall { agent, tool, call_id, args_summary,
                                   bee_state, task_id, at } => {
                let call = ToolCall {
                    call_id,
                    agent: agent.clone(),
                    tool,
                    args_summary,
                    bee_state: BeeState::from_str(&bee_state),
                    started_at: at,
                    settled: false,
                    ok: None,
                    duration_ms: None,
                };
                // An agent that just ran something is not waiting on anything.
                self.swarm.clear_waiting(&agent);
                self.thought.push_tool_start(&call, at);
                self.swarm.start_call(call);
                let _ = task_id;
            }
            BunMessage::ToolDone { agent, tool, call_id, ok, duration_ms,
                                   result_summary, task_id, at } => {
                let settled = self.swarm.settle_call(&call_id, ok, duration_ms);
                // El cierre va al stream aunque el `tool_call` se hubiera
                // perdido: así la lista muestra la tool cerrada y no un spinner
                // eterno.
                self.thought.push(StreamEntry::ToolDone {
                    agent: agent.clone(),
                    ts: at,
                    call_id: call_id.clone(),
                    tool: tool.clone(),
                    ok,
                    duracion_ms: duration_ms,
                    resumen: result_summary.clone(),
                });
                if !settled {
                    // El `tool_call` se perdió en el canal `low`. Sin esto el
                    // spinner de esa tool giraría para siempre; lo registramos
                    // como un evento más para que la UI pueda decirlo.
                    self.swarm.start_call(ToolCall {
                        call_id: call_id.clone(),
                        agent: agent.clone(),
                        tool,
                        args_summary: String::new(),
                        bee_state: if ok { BeeState::Done } else { BeeState::Error },
                        started_at: at,
                        settled: true,
                        ok: Some(ok),
                        duration_ms: Some(duration_ms),
                    });
                    self.swarm.settle_call(&call_id, ok, duration_ms);
                }
                let _ = result_summary;
                let _ = task_id;
            }
            BunMessage::Esperando { agent, esperando_a, razon, task_id, at } => {
                let waiting = WaitingAgent {
                    agent: agent.clone(),
                    waiting_for: esperando_a,
                    reason: razon,
                    since: at,
                };
                self.thought.push_waiting(&waiting);
                self.swarm.set_waiting(waiting);
                let _ = task_id;
            }
            BunMessage::CargaActual { agent, tools, skills, origen, minimal, at } => {
                // Reemplaza, no acumula: cada turno emite la suya y la anterior
                // ya no describe lo que el agente tiene delante.
                self.loadout.insert(
                    agent,
                    Loadout {
                        tools,
                        skills,
                        pruned: origen == "jev_pruned",
                        minimal,
                        at,
                    },
                );
            }
            // ── Roster del enjambre ─────────────────────────────────────────────
            // Snapshot completo: reemplaza, no acumula. Un agente archivado
            // tiene que desaparecer de la UI.
            BunMessage::RosterSnapshot { agentes, mcp_servers } => {
                self.roster.apply(agentes);
                self.roster.mcp_servers = mcp_servers
                    .into_iter()
                    .map(|s| crate::state::McpRef {
                        id: s.id,
                        name: s.name,
                        tools: s.tools,
                        state: crate::state::McpState::from_str(&s.state),
                    })
                    .collect();
            }

            // ── Alertas ────────────────────────────────────────────────────────
            BunMessage::ConflictAlert { agent_a, agent_b, file, reason, severity, detail } => {
                self.harness.active_workspace_status = Some("conflict".to_string());
                self.harness.last_activity = Some(short_event_text(&reason));
                self.conflicts.entries.push(AgentConflict {
                    agent_a,
                    agent_b,
                    path: file,
                    reason,
                    severity,
                    detail,
                });
            }
            BunMessage::Error { message } => {
                self.harness.active_workspace_status = Some("error".to_string());
                self.harness.last_activity = Some(short_event_text(&message));
                self.history.entries.push(HistoryEntry {
                    role: Role::System,
                    content: format!("Error: {message}"),
                    agent: None,
                    timestamp: None,
                });
                self.history.selected = Some(self.history.entries.len().saturating_sub(1));
                self.history.scroll = 0;
                self.running = false;
                self.status_msg = "Error".to_string();
                self.recommend_layout(TabId::Mesa, LayoutStage::Failed, "error -> Focus");
                self.logs.entries.push(LogEntry {
                    timestamp: "ERR".to_string(),
                    level: "error".to_string(),
                    source: "ipc".to_string(),
                    message,
                });
                if self.logs.entries.len() > self.logs.capacity {
                    self.logs.entries.remove(0);
                }
            }

            // ── Rollback completado ────────────────────────────────────────────
            BunMessage::CheckpointRollback { checkpoint_id, files_restored } => {
                self.logs.entries.push(LogEntry {
                    timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                    level: "info".to_string(),
                    source: "rollback".to_string(),
                    message: format!("↩ {checkpoint_id} — {files_restored} archivo(s) restaurado(s)"),
                });
                if self.logs.entries.len() > self.logs.capacity {
                    self.logs.entries.remove(0);
                }
            }

            // ── ADRs ───────────────────────────────────────────────────────────
            BunMessage::AdrUpdate { path, title, content, status } => {
                if let Some(e) = self.adrs.entries.iter_mut().find(|e| e.path == path) {
                    e.title = title; e.content = content; e.status = status;
                } else {
                    self.adrs.entries.push(AdrEntry { path, title, content, status });
                }
            }

            // ── Plan estructurado ───────────────────────────────────────────────
            BunMessage::PlanUpdate { task_id, adr_title, adr_content, status, phases, risks, api_contracts } => {
                if adr_title.trim().is_empty() || adr_content.trim().is_empty() || phases.is_empty() {
                    self.history.entries.push(HistoryEntry {
                        role: Role::System,
                        content: "Error: el plan recibido esta incompleto; falta ADR o fases para revisarlo.".to_string(),
                        agent: None,
                        timestamp: None,
                    });
                    self.history.selected = Some(self.history.entries.len().saturating_sub(1));
                    self.history.scroll = 0;
                    self.status_msg = "Error de plan".to_string();
                    self.recommend_layout(TabId::Mesa, LayoutStage::Failed, "plan incompleto -> Focus");
                    return;
                }
                self.harness.active_task_id = Some(task_id.clone());
                self.harness.active_task_title = Some(adr_title.clone());
                self.harness.active_task_status = Some(status.clone());
                self.harness.approval_pending = status == "pending" || status == "approval";
                self.plan.current = Some(crate::state::PlanEntry {
                    task_id,
                    adr_title,
                    adr_content,
                    status,
                    phases: phases.into_iter().map(|p| crate::state::PlanPhase {
                        name: p.name,
                        coordinator: p.coordinator,
                        description: p.description,
                        depends_on: p.depends_on,
                        level: p.level,
                        status: p.status,
                    }).collect(),
                    risks: risks.into_iter().map(|r| crate::state::PlanRisk {
                        severity: r.severity,
                        description: r.description,
                    }).collect(),
                    api_contracts: api_contracts.into_iter().map(map_api_contract).collect(),
                });
                self.plan.selected_phase = 0;
                self.plan.scroll = 0;
                self.filemap.scroll = 0;
                self.adrs.scroll = 0;
                if let Some(plan) = self.plan.current.as_ref() {
                    self.dashboard.levels = dashboard_levels_from_phases(&plan.phases);
                }
                self.recommend_layout(TabId::Plan, LayoutStage::Planning, "plan estructurado -> Plan");
            }
            BunMessage::PlanDraftUpdate { task_id, adr_title, adr_content, phases, risks, api_contracts } => {
                let task_id = task_id
                    .or_else(|| self.harness.active_task_id.clone())
                    .unwrap_or_else(|| "draft".to_string());
                let mut current = self.plan.current.clone().unwrap_or_default();
                current.task_id = task_id.clone();
                if let Some(title) = adr_title.filter(|title| !title.trim().is_empty()) {
                    current.adr_title = title;
                }
                if let Some(content) = adr_content.filter(|content| !content.trim().is_empty()) {
                    current.adr_content = content;
                }
                if !phases.is_empty() {
                    current.phases = phases.into_iter().map(|p| crate::state::PlanPhase {
                        name: p.name,
                        coordinator: p.coordinator,
                        description: p.description,
                        depends_on: p.depends_on,
                        level: p.level,
                        status: p.status,
                    }).collect();
                }
                if !risks.is_empty() {
                    current.risks = risks.into_iter().map(|r| crate::state::PlanRisk {
                        severity: r.severity,
                        description: r.description,
                    }).collect();
                }
                if !api_contracts.is_empty() {
                    current.api_contracts = api_contracts.into_iter().map(map_api_contract).collect();
                }
                if current.status.is_empty() {
                    current.status = "draft".to_string();
                }
                if current.adr_title.is_empty() {
                    current.adr_title = "ADR en redacción".to_string();
                }
                self.harness.active_task_id = Some(task_id);
                self.harness.active_task_title = Some(current.adr_title.clone());
                self.harness.active_task_status = Some("planning".to_string());
                self.plan.current = Some(current);
                if let Some(plan) = self.plan.current.as_ref() {
                    self.dashboard.levels = dashboard_levels_from_phases(&plan.phases);
                }
                self.recommend_layout(TabId::Plan, LayoutStage::Planning, "Architect construye plan -> Plan");
            }

            BunMessage::ReviewVerdictUpdate { reviewer, status, summary, observations, requested_changes, affected_files, criteria, categories } => {
                let reviewer = reviewer.unwrap_or_else(|| "reviewer".to_string());
                self.harness.last_agent = Some(reviewer.clone());
                self.harness.active_task_status = Some(status.clone());
                self.review.verdict = Some(ReviewVerdict {
                    reviewer,
                    status,
                    summary,
                    observations,
                    requested_changes,
                    affected_files,
                    criteria: criteria
                        .into_iter()
                        .map(|c| ReviewCriterion { description: c.description, met: c.met, evidence: c.evidence })
                        .collect(),
                    categories: categories
                        .into_iter()
                        .map(|c| ReviewCategory { name: c.name, status: c.status, detail: c.detail })
                        .collect(),
                });
                self.recommend_layout(TabId::Review, LayoutStage::Reviewing, "Reviewer emitió veredicto -> Review");
            }

            BunMessage::ResumeAvailable { task_id, checkpoint_id, reason } => {
                self.dashboard.resume = Some(ResumeInfo { task_id, checkpoint_id, reason: reason.clone() });
                self.dashboard.push_blackboard_event(BlackboardEvent {
                    timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                    agent: "system".to_string(),
                    event_type: "RESUME".to_string(),
                    content: short_event_text(&reason),
                });
                self.recommend_layout(TabId::Swarm, LayoutStage::Failed, "checkpoint disponible para reanudar -> Dashboard");
            }

            BunMessage::PhaseRetry { worker, attempt, max_attempts, reason } => {
                self.upsert_worker(
                    worker.clone(),
                    None,
                    WorkerStatus::Warn,
                    None,
                    Some(format!("retry {attempt}/{max_attempts}")),
                    None,
                    None,
                    Some(short_event_text(&reason)),
                    None,
                    Some(attempt),
                    Some(max_attempts),
                    None,
                    None,
                );
                self.dashboard.push_blackboard_event(BlackboardEvent {
                    timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                    agent: worker,
                    event_type: "RETRY".to_string(),
                    content: format!("intento {attempt}/{max_attempts}: {}", short_event_text(&reason)),
                });
            }

            // ── Proyección de tareas ────────────────────────────────────────────
            BunMessage::TaskUpdate {
                task_id,
                title,
                status,
                mode,
                active_workers,
                workspace_id,
                workspace_path,
                branch_name,
                isolated,
                integration_status,
            } => {
                self.harness.active_task_id = Some(task_id.clone());
                if let Some(title) = title.as_ref().filter(|title| !title.trim().is_empty()) {
                    self.harness.active_task_title = Some(title.clone());
                }
                self.harness.active_task_status = Some(status.clone());
                if let Some(path) = workspace_path.as_ref().filter(|path| !path.trim().is_empty()) {
                    self.harness.active_workspace_path = Some(path.clone());
                }
                let workspace_status = integration_status
                    .clone()
                    .or_else(|| isolated.filter(|value| *value).map(|_| "isolated".to_string()));
                if let Some(workspace_status) = workspace_status {
                    self.harness.active_workspace_status = Some(workspace_status);
                }
                if matches!(status.as_str(), "completed" | "done" | "failed" | "cancelled") {
                    self.harness.approval_pending = false;
                }
                self.tasks.upsert(
                    task_id,
                    title,
                    status.clone(),
                    mode,
                    active_workers,
                    workspace_id,
                    workspace_path,
                    branch_name,
                    isolated,
                    integration_status,
                );
                self.session.task_count = self.session.task_count.max(self.tasks.tasks.len() as u32);
                if matches!(status.as_str(), "completed" | "done" | "cancelled") {
                    self.recommend_layout(TabId::Mesa, LayoutStage::Completed, "tarea completa -> Focus");
                } else if status == "failed" {
                    self.recommend_layout(TabId::Mesa, LayoutStage::Failed, "tarea fallida -> Focus");
                } else {
                    let count = self.active_execution_workers().len();
                    if count >= 2 {
                        self.recommend_layout(TabId::Swarm, LayoutStage::Executing, format!("{count} workers activos -> Dashboard"));
                    } else if count == 1 {
                        self.recommend_layout(TabId::Code, LayoutStage::Executing, "1 worker activo -> Code");
                    }
                }
            }

            // ── Aprobación del plan ─────────────────────────────────────────────
            BunMessage::PlanApprovalRequest => {
                self.harness.approval_pending = true;
                self.harness.active_task_status = Some("approval".to_string());
                self.modal = ModalState::PlanApproval(PlanApprovalState { selected: 0 });
                self.recommend_layout(TabId::Plan, LayoutStage::Planning, "plan esperando aprobación -> Plan");
            }

            // ── Diff activo ─────────────────────────────────────────────────────
            BunMessage::FileDiff { path, branch, stats_added, stats_removed, chunks } => {
                self.diff.path = path;
                self.diff.branch = branch.unwrap_or_default();
                self.diff.stats_added = stats_added.unwrap_or(0);
                self.diff.stats_removed = stats_removed.unwrap_or(0);
                self.diff.lines = chunks;
                self.diff.scroll = 0;
                self.harness.active_workspace_status = Some("diff".to_string());
                self.route_after_diff();
            }

            // ── Snapshots de inicio (storage → IPC) ────────────────────────────
            BunMessage::WorkersSnapshot { workers } => {
                for w in workers {
                    let status = status_to_worker_status(&w.status);
                    self.upsert_worker(
                        w.name.clone(),
                        w.detail.clone(),
                        status,
                        w.display_name,
                        w.activity.clone(),
                        w.token_count,
                        w.level,
                        w.current_action,
                        w.current_file,
                        w.iteration_current,
                        w.iteration_total,
                        w.transversal,
                        w.replaces_worker,
                    );
                }
                // Igual que DashboardSnapshot: hidratar sin cambiar de layout.
            }
            BunMessage::FilesSnapshot { files } => {
                for f in files {
                    let risk = match f.risk.as_str() {
                        "medium"   => RiskLevel::Medium,
                        "high"     => RiskLevel::High,
                        "critical" => RiskLevel::Critical,
                        _          => RiskLevel::Low,
                    };
                    if let Some(e) = self.filemap.entries.iter_mut().find(|e| e.path == f.path) {
                        e.risk = risk; e.operation = f.operation; e.agent = f.agent;
                        e.adr_ref = None; e.lines_added = 0; e.lines_removed = 0;
                    } else {
                        self.filemap.entries.push(FileEntry { path: f.path, risk, operation: f.operation, agent: f.agent, adr_ref: None, lines_added: 0, lines_removed: 0 });
                    }
                }
            }

            // ── No-ops ─────────────────────────────────────────────────────────
            BunMessage::QuickMenu { .. }
            | BunMessage::Suspend
            | BunMessage::Resume
            | BunMessage::ContextUpdate { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{BunMessage, PlanPhaseIpc, PlanRiskIpc};

    #[test]
    fn plan_mode_routes_to_plan_while_architect_is_generating() {
        let mut state = AppState::default();

        state.apply_message(BunMessage::StateUpdate {
            new_mode: Some("plan".to_string()),
            new_provider: None,
            new_model: None,
            new_token_count: None,
        });
        state.apply_message(BunMessage::ActivityUpdate {
            task_id: None,
            coordinator: "architecture".to_string(),
            phase: "reading".to_string(),
            status: "running".to_string(),
            display_name: None,
            activity: None,
            token_count: None,
            level: None,
            current_action: None,
            current_file: None,
            iteration_current: None,
            iteration_total: None,
            transversal: None,
        });

        assert_eq!(state.active_tab, TabId::Plan);
        state.history_nav_mode = true;

        state.apply_message(BunMessage::PlanUpdate {
            task_id: "task-1".to_string(),
            adr_title: "ADR de layout".to_string(),
            adr_content: "Contexto y decision completos.".to_string(),
            status: "pending".to_string(),
            phases: vec![PlanPhaseIpc {
                name: "Revisar".to_string(),
                coordinator: "architecture".to_string(),
                description: "Preparar revision".to_string(),
                depends_on: Vec::new(),
                level: 0,
                status: "pending".to_string(),
            }],
            risks: vec![PlanRiskIpc {
                severity: "LOW".to_string(),
                description: "Sin cambios destructivos".to_string(),
            }],
            api_contracts: Vec::new(),
        });

        assert_eq!(state.active_tab, TabId::Plan);
        // Ya estábamos en Plan: la recomendación no cambia de tab, así que tampoco
        // debe sacar al usuario del modo lectura en el que estaba.
        assert!(state.history_nav_mode);
        assert!(state.plan.current.is_some());
    }

    #[test]
    fn incomplete_plan_is_reported_in_focus_instead_of_opening_plan() {
        let mut state = AppState::default();
        state.session.mode = ReplMode::Plan;

        state.apply_message(BunMessage::PlanUpdate {
            task_id: "task-1".to_string(),
            adr_title: String::new(),
            adr_content: String::new(),
            status: "pending".to_string(),
            phases: Vec::new(),
            risks: Vec::new(),
            api_contracts: Vec::new(),
        });

        assert_eq!(state.active_tab, TabId::Mesa);
        assert!(state.plan.current.is_none());
        assert!(state
            .history
            .entries
            .last()
            .is_some_and(|entry| entry.content.contains("incompleto")));
    }

    #[test]
    fn task_update_tracks_active_projection_and_routes_dashboard_with_two_workers() {
        let mut state = AppState::default();

        state.apply_message(BunMessage::TaskUpdate {
            task_id: "task-1".to_string(),
            title: Some("Corregir login".to_string()),
            status: "running".to_string(),
            mode: Some("auto".to_string()),
            active_workers: Some(vec!["backend".to_string(), "frontend".to_string()]),
            workspace_id: Some("worktree:task-1".to_string()),
            workspace_path: Some("/tmp/task-1".to_string()),
            branch_name: Some("hivecode/task-task-1".to_string()),
            isolated: Some(true),
            integration_status: Some("isolated".to_string()),
        });

        assert_eq!(state.active_tab, TabId::Swarm);
        assert_eq!(state.tasks.active_task_id.as_deref(), Some("task-1"));
        assert_eq!(state.tasks.tasks[0].title, "Corregir login");
        assert_eq!(state.tasks.tasks[0].active_workers.len(), 2);
        assert!(state.tasks.tasks[0].isolated);
        assert_eq!(state.harness.active_task_id.as_deref(), Some("task-1"));
        assert_eq!(state.harness.active_task_title.as_deref(), Some("Corregir login"));
        assert_eq!(state.harness.active_workspace_path.as_deref(), Some("/tmp/task-1"));
        assert_eq!(state.harness.active_workspace_status.as_deref(), Some("isolated"));
        assert_eq!(state.harness.last_event_type, "task_update");
    }

    #[test]
    fn routed_worker_update_marks_task_projection() {
        let mut state = AppState::default();

        state.apply_message(BunMessage::WorkerUpdate {
            task_id: Some("task-1".to_string()),
            worker: "backend".to_string(),
            phase: "editing".to_string(),
            status: "running".to_string(),
            display_name: None,
            activity: None,
            token_count: None,
            level: None,
            current_action: None,
            current_file: None,
            iteration_current: None,
            iteration_total: None,
            transversal: None,
        });

        assert_eq!(state.tasks.active_task_id.as_deref(), Some("task-1"));
        assert_eq!(state.tasks.tasks[0].active_workers, vec!["backend".to_string()]);
        assert_eq!(state.session.task_count, 1);

        state.apply_message(BunMessage::WorkerUpdate {
            task_id: Some("task-1".to_string()),
            worker: "backend".to_string(),
            phase: "done".to_string(),
            status: "done".to_string(),
            display_name: None,
            activity: None,
            token_count: None,
            level: None,
            current_action: None,
            current_file: None,
            iteration_current: None,
            iteration_total: None,
            transversal: None,
        });

        assert!(state.tasks.tasks[0].active_workers.is_empty());
        assert_eq!(state.tasks.tasks[0].status, "running");
        assert_eq!(state.harness.last_agent.as_deref(), Some("backend"));
        assert_eq!(state.harness.last_phase.as_deref(), Some("done"));
        assert_eq!(state.harness.active_task_status.as_deref(), Some("done"));
    }

    #[test]
    fn plan_approval_sets_harness_pending_state() {
        let mut state = AppState::default();

        state.apply_message(BunMessage::PlanApprovalRequest);

        assert!(state.harness.approval_pending);
        assert_eq!(state.harness.active_task_status.as_deref(), Some("approval"));
        assert_eq!(state.active_tab, TabId::Plan);
    }

    #[test]
    fn state_update_refreshes_token_count() {
        let mut state = AppState::default();

        state.apply_message(BunMessage::StateUpdate {
            new_mode: None,
            new_provider: None,
            new_model: None,
            new_token_count: Some(42_000),
        });

        assert_eq!(state.session.token_count, 42_000);
    }

    #[test]
    fn session_changed_adopts_the_new_id_and_drops_the_previous_transcript() {
        let mut state = AppState::default();

        // A session's worth of state, as if we had been talking in it.
        state.apply_message(BunMessage::Init {
            mode: Some("approval".to_string()),
            provider: Some("anthropic".to_string()),
            model: Some("claude-sonnet-5".to_string()),
            project_name: Some("mi-app".to_string()),
            project_path: Some("/tmp/mi-app".to_string()),
            session_id: "old-session-1".to_string(),
            version: Some("0.1.0".to_string()),
            task_count: Some(0),
            token_count: Some(0),
            workers: vec![],
        });
        for (i, content) in ["hola", "qué tal", "hazme un test"].iter().enumerate() {
            state.apply_message(BunMessage::HistoryAppend {
                role: if i % 2 == 0 { "user".to_string() } else { "assistant".to_string() },
                content: content.to_string(),
                content_type: None,
                agent: None,
                timestamp: None,
            });
        }
        assert_eq!(state.history.entries.len(), 3);
        assert_eq!(state.session.session_id, "old-session-1");

        state.apply_message(BunMessage::SessionChanged { session_id: "new-session-2".to_string() });

        // The id moves; the transcript of the previous session does not survive.
        assert_eq!(state.session.session_id, "new-session-2");
        assert!(state.history.entries.is_empty());
    }

    #[test]
    fn session_changed_preserves_the_chosen_mode() {
        let mut state = AppState::default();
        state.session.mode = ReplMode::Auto;

        state.apply_message(BunMessage::SessionChanged { session_id: "s-1".to_string() });

        // Switching sessions is not a mode change — the user's choice stands.
        assert_eq!(state.session.mode, ReplMode::Auto);
        assert_eq!(state.session.session_id, "s-1");
    }

    #[test]
    fn dashboard_routes_when_two_workers_are_running() {
        let mut state = AppState::default();

        for worker in ["backend", "frontend"] {
            state.apply_message(BunMessage::WorkerUpdate {
                task_id: Some("task-1".to_string()),
                worker: worker.to_string(),
                phase: "editing".to_string(),
                status: "running".to_string(),
                display_name: None,
                activity: None,
                token_count: None,
                level: None,
                current_action: None,
                current_file: None,
                iteration_current: None,
                iteration_total: None,
                transversal: None,
            });
        }

        assert_eq!(state.active_tab, TabId::Swarm);
    }

    #[test]
    fn bee_respond_or_fix_routes_to_focus() {
        let mut state = AppState::default();
        state.active_tab = TabId::Code;

        state.apply_message(BunMessage::WorkerUpdate {
            task_id: Some("task-1".to_string()),
            worker: "bee".to_string(),
            phase: "respond".to_string(),
            status: "running".to_string(),
            display_name: None,
            activity: Some("preparando respuesta".to_string()),
            token_count: None,
            level: None,
            current_action: None,
            current_file: None,
            iteration_current: None,
            iteration_total: None,
            transversal: None,
        });

        assert_eq!(state.active_tab, TabId::Mesa);
    }

    #[test]
    fn bee_and_unscoped_tool_workers_stay_in_focus() {
        let mut state = AppState::default();

        state.apply_message(BunMessage::ActivityUpdate {
            task_id: Some("task-1".to_string()),
            coordinator: "bee".to_string(),
            phase: "thinking".to_string(),
            status: "running".to_string(),
            display_name: None,
            activity: Some("clasificando solicitud".to_string()),
            token_count: None,
            level: None,
            current_action: None,
            current_file: None,
            iteration_current: None,
            iteration_total: None,
            transversal: None,
        });
        state.apply_message(BunMessage::ActivityUpdate {
            task_id: None,
            coordinator: "worker-0".to_string(),
            phase: "fs_read".to_string(),
            status: "running".to_string(),
            display_name: None,
            activity: Some("executing fs_read".to_string()),
            token_count: None,
            level: None,
            current_action: None,
            current_file: None,
            iteration_current: None,
            iteration_total: None,
            transversal: None,
        });

        assert_eq!(state.active_tab, TabId::Mesa);
        assert_eq!(state.routing.recommended_tab, TabId::Mesa);
    }

    #[test]
    fn manual_layout_override_persists_until_auto_is_resumed() {
        let mut state = AppState::default();
        state.active_tab = TabId::Review;
        state.tab_locked = true;

        for worker in ["backend", "frontend"] {
            state.apply_message(BunMessage::WorkerUpdate {
                task_id: Some("task-1".to_string()),
                worker: worker.to_string(),
                phase: "editing".to_string(),
                status: "running".to_string(),
                display_name: None,
                activity: None,
                token_count: None,
                level: Some(2),
                current_action: None,
                current_file: None,
                iteration_current: None,
                iteration_total: None,
                transversal: None,
            });
        }

        assert_eq!(state.active_tab, TabId::Review);
        assert_eq!(state.routing.recommended_tab, TabId::Swarm);
        state.resume_auto_layout();
        assert_eq!(state.active_tab, TabId::Swarm);
        assert!(!state.tab_locked);
    }

    #[test]
    fn review_verdict_routes_to_review_and_stores_summary() {
        let mut state = AppState::default();
        state.active_tab = TabId::Code;

        state.apply_message(BunMessage::ReviewVerdictUpdate {
            reviewer: Some("reviewer".to_string()),
            status: "approval".to_string(),
            summary: "Listo para aprobar con una observacion menor.".to_string(),
            observations: vec!["Cobertura suficiente".to_string()],
            requested_changes: vec!["Ajustar copy".to_string()],
            affected_files: vec!["src/app.ts".to_string()],
            criteria: vec![],
            categories: vec![],
        });

        assert_eq!(state.active_tab, TabId::Review);
        let verdict = state.review.verdict.as_ref().expect("verdict");
        assert_eq!(verdict.summary, "Listo para aprobar con una observacion menor.");
        assert_eq!(verdict.affected_files, vec!["src/app.ts".to_string()]);
    }
}

#[cfg(test)]
mod loadout_tests {
    use super::*;
    use crate::ipc::BunMessage;

    fn state_with_roster() -> AppState {
        let mut state = AppState::default();
        state.roster.apply(vec![crate::ipc::IpcRosterAgent {
            id: "agent-1".into(),
            rol: "backend".into(),
            alias: "Topo".into(),
            funcion: "Construye servicios.".into(),
            nivel: 2,
            tools: vec!["fs_read".into(), "fs_write".into()],
            mcp: vec![],
        }]);
        state
    }

    #[test]
    fn a_loadout_replaces_the_previous_one_for_that_agent() {
        // Cada turno emite la suya; la anterior ya no describe lo que el agente
        // tiene delante. Acumular las dos sería mentir.
        let mut state = state_with_roster();
        state.apply_message(BunMessage::CargaActual {
            agent: "agent-1".into(),
            tools: vec!["fs_read".into(), "fs_write".into()],
            skills: vec!["busqueda_hivedb".into()],
            origen: "perfil".into(),
            minimal: vec!["busqueda_hivedb".into()],
            at: 1,
        });
        state.apply_message(BunMessage::CargaActual {
            agent: "agent-1".into(),
            tools: vec!["fs_read".into()],
            skills: vec![],
            origen: "jev_pruned".into(),
            minimal: vec![],
            at: 2,
        });

        let loadout = &state.loadout["agent-1"];
        assert_eq!(loadout.tools.len(), 1, "la carga anterior sigue ahí");
        assert!(loadout.pruned, "no marca que JEV podó");
        assert_eq!(loadout.at, 2);
    }

    #[test]
    fn the_pruned_flag_survives_the_wire() {
        let mut state = state_with_roster();
        state.apply_message(BunMessage::CargaActual {
            agent: "agent-1".into(),
            tools: vec![],
            skills: vec![],
            origen: "jev_pruned".into(),
            minimal: vec![],
            at: 1,
        });
        assert!(state.loadout["agent-1"].pruned);
    }

    #[test]
    fn loadouts_of_different_agents_do_not_overwrite_each_other() {
        let mut state = state_with_roster();
        for agent in ["agent-1", "agent-2"] {
            state.apply_message(BunMessage::CargaActual {
                agent: agent.into(),
                tools: vec![format!("{agent}-tool")],
                skills: vec![],
                origen: "perfil".into(),
                minimal: vec![],
                at: 1,
            });
        }
        assert_eq!(state.loadout.len(), 2);
        assert!(state.loadout["agent-2"].tool("agent-2-tool"));
    }

    #[test]
    fn a_loadout_is_keyed_by_id_so_the_card_can_find_it() {
        // La ficha busca por `agent.id`, no por rol: es como llegan los eventos.
        let mut state = state_with_roster();
        state.apply_message(BunMessage::CargaActual {
            agent: "agent-1".into(),
            tools: vec!["fs_read".into()],
            skills: vec![],
            origen: "perfil".into(),
            minimal: vec![],
            at: 1,
        });
        let agent = &state.roster.by_id["agent-1"];
        assert!(state.loadout.get(&agent.id).is_some());
        // Y no por rol: un id no es un rol.
        assert!(state.loadout.get(&agent.rol).is_none());
    }

    #[test]
    fn skills_from_settings_land_in_the_library_with_their_tools() {
        let mut state = AppState::default();
        state.library = SkillLibrary { skills: vec![] };
        // El payload llega por `settings_data`; aquí se comprueba el tipo.
        let payload = crate::ipc::IpcSettingsSkill {
            name: "browser_automate".into(),
            description: "21 tools".into(),
            category: "web".into(),
            active: true,
            tools: vec!["browser_click".into(), "browser_fill".into()],
            preferida_por: vec!["frontend".into()],
            siempre_disponible: false,
        };
        let card = SkillCard {
            name: payload.name,
            description: payload.description,
            category: payload.category,
            active: payload.active,
            tools: payload.tools,
            preferida_por: payload.preferida_por,
            siempre_disponible: payload.siempre_disponible,
        };
        assert_eq!(card.tools.len(), 2);
        assert!(card.prefers_role("frontend"));
        assert_eq!(card.fit_for(&["fs_read".to_string()]), crate::state::SkillFit::Blocked);
    }
}
