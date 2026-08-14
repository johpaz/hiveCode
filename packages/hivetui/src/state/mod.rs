#![allow(dead_code)]

mod adr;
mod agent_graph;
mod checkpoint;
mod conflicts;
mod dashboard;
mod diff;
mod dirty;
mod filemap;
mod harness;
mod history;
mod input;
mod logs;
mod modal;
mod panels;
mod plan;
mod review;
mod routing;
mod session;
mod tasks;
mod thought;
mod workers;

pub use adr::{AdrEntry, AdrState};
pub use agent_graph::{AgentTier, agent_color, all_edges, display_name as agent_display_name, edges_from, edges_to, tier_for};
pub use checkpoint::{Checkpoint, CheckpointState};
pub use conflicts::{AgentConflict, ConflictState};
pub use dashboard::{
    BlackboardEvent, DashboardLevel, DashboardLevelStatus, DashboardState, HaltState, ResumeInfo, SecurityState,
};
pub use diff::DiffState;
pub use crate::ipc::DiffLine;
pub use dirty::DirtyFlags;
pub use filemap::{FileEntry, FileMapState, RiskLevel};
pub use harness::{HarnessHealth, HarnessState};
pub use history::{HistoryEntry, HistoryState, Role};
pub use input::InputState;
pub use logs::{LogEntry, LogState};
pub use modal::{
    ConfigModalState, InfoModalState, ModalField, ModalFieldKind, ModalState,
    PlanApprovalState, ReviewAction, ReviewConfirmState, SettingsHubState, SettingsMcp,
    SettingsAgent, SettingsProvider, SettingsSkill, SettingsTab,
};
pub use panels::PanelLayoutState;
pub use plan::{ApiContract, PlanEntry, PlanPhase, PlanRisk, PlanState};
pub use review::{ReviewCategory, ReviewCriterion, ReviewState, ReviewVerdict};
pub use routing::{LayoutRoutingState, LayoutStage};
pub use session::{ReplMode, SessionState, TabId};
pub use tasks::{TaskProjection, TaskProjectionState};
pub use thought::{ThoughtChunk, ThoughtStreamState};
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
    pub dirty: DirtyFlags,
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
        if !self.tab_locked {
            let changed = self.active_tab != self.routing.recommended_tab;
            self.active_tab = self.routing.recommended_tab;
            self.history_nav_mode = false;
            self.history_hscroll = 0;
            if changed {
                self.dirty.full = true;
            }
        }
    }

    pub fn resume_auto_layout(&mut self) {
        self.tab_locked = false;
        self.active_tab = self.routing.recommended_tab;
        self.history_nav_mode = false;
        self.history_hscroll = 0;
        self.dirty.full = true;
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
            self.recommend_layout(TabId::Focus, LayoutStage::Classifying, reason);
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
                TabId::Dashboard,
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
            self.recommend_layout(TabId::Dashboard, LayoutStage::Executing, "workers paralelos -> Dashboard");
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
        self.dirty.session = true;
        self.dirty.full = true;
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
            worker.display_name = display_name.unwrap_or(name);
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
                        self.active_tab = TabId::Focus;
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
                self.dirty.session = true;
                self.dirty.workers = true;
                self.dirty.full = true;
            }

            // ── Respuesta del agente ───────────────────────────────────────────
            BunMessage::AssistantChunk { text, agent, timestamp } => {
                if let Some(agent_name) = agent.as_ref().filter(|agent| !agent.trim().is_empty()) {
                    self.harness.last_agent = Some(agent_name.clone());
                }
                match self.history.entries.last_mut() {
                    Some(e) if e.role == Role::Assistant => e.content.push_str(&text),
                    _ => self.history.entries.push(HistoryEntry {
                        role: Role::Assistant,
                        content: text,
                        agent,
                        timestamp,
                    }),
                }
                self.history.scroll = 0;
                self.history.selected = Some(self.history.entries.len().saturating_sub(1));
                self.dirty.history = true;
            }
            BunMessage::AssistantDone => {
                self.running = false;
                if !self.harness.approval_pending {
                    self.harness.active_task_status = Some("idle".to_string());
                }
                self.history.scroll = 0;
                if self.session.mode == ReplMode::Plan && self.plan.current.is_some() {
                    self.recommend_layout(TabId::Plan, LayoutStage::Planning, "plan listo -> Plan");
                } else {
                    self.recommend_layout(TabId::Focus, LayoutStage::Completed, "tarea completa -> Focus");
                }
                self.dirty.full = true;
                self.dirty.history = true;
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
                        self.recommend_layout(TabId::Focus, LayoutStage::Completed, "respuesta completa -> Focus");
                    }
                    self.dirty.full = true;
                }
                self.dirty.history = true;
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
                        self.recommend_layout(TabId::Focus, LayoutStage::Completed, "tarea finalizada -> Focus");
                    }
                }
                self.dirty.session = true;
            }
            BunMessage::StateUpdate { new_mode, new_provider, new_model, new_token_count } => {
                if let Some(m) = new_mode {
                    self.session.mode = ReplMode::from(m.as_str());
                    if self.session.mode == ReplMode::Plan {
                        self.plan.current = None;
                        self.plan.scroll = 0;
                    }
                    self.recommend_layout(TabId::Focus, LayoutStage::Idle, "modo actualizado -> Focus");
                    self.dirty.full = true;
                }
                if let Some(p) = new_provider { self.session.provider = p; }
                if let Some(m) = new_model { self.session.model = m; }
                if let Some(t) = new_token_count { self.session.token_count = t; }
                self.dirty.session = true;
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
                self.dirty.workers = true;
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
                self.dirty.workers = true;
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
                self.dirty.full = true;
                self.dirty.workers = true;
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
                self.dirty.full = true;
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
                self.dirty.full = true;
            }
            BunMessage::BlackboardEvent { timestamp, agent, event_type, content } => {
                self.dashboard.push_blackboard_event(BlackboardEvent {
                    timestamp,
                    agent,
                    event_type,
                    content,
                });
                self.dirty.full = true;
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
                self.dirty.conflicts = true;
                self.dirty.full = true;
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
                self.recommend_layout(TabId::Dashboard, LayoutStage::Failed, "análisis forense -> Dashboard");
                self.dirty.full = true;
            }
            BunMessage::SecurityStatusUpdate { status, findings } => {
                self.dashboard.security.status = status;
                self.dashboard.security.findings = findings.unwrap_or(self.dashboard.security.findings);
                self.dirty.full = true;
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
                    self.recommend_layout(TabId::Dashboard, LayoutStage::Failed, "HALT activo -> Dashboard");
                }
                self.dirty.full = true;
            }
            BunMessage::MetricsUpdate { token_count, cost, elapsed_secs } => {
                if let Some(tokens) = token_count {
                    self.session.token_count = tokens;
                }
                if let Some(cost) = cost {
                    self.cost = cost;
                }
                self.dashboard.metrics.elapsed_secs = elapsed_secs.or(self.dashboard.metrics.elapsed_secs);
                self.dirty.session = true;
                self.dirty.full = true;
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
                self.dirty.checkpoints = true;
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
                self.dirty.filemap = true;
            }

            // ── Stream de pensamiento ──────────────────────────────────────────
            BunMessage::ThoughtChunk { task_id, coordinator, phase, content } => {
                self.harness.last_agent = Some(coordinator.clone());
                self.harness.last_phase = Some(phase.clone());
                self.harness.last_activity = Some(short_event_text(&content));
                self.thought.chunks.push(ThoughtChunk { coordinator, phase, content });
                if self.thought.chunks.len() > 100 { self.thought.chunks.remove(0); }
                if let Some(chunk) = self.thought.chunks.last() {
                    let coordinator = chunk.coordinator.clone();
                    let phase = chunk.phase.clone();
                    let content = chunk.content.clone();
                    self.note_task_worker(task_id, &coordinator, "thinking");
                    self.route_after_worker_activity(&coordinator, &phase, "thinking", Some(&content));
                }
                self.dirty.thought = true;
            }
            BunMessage::NarrativeChunk { task_id, coordinator, phase, content, .. } => {
                self.harness.last_agent = Some(coordinator.clone());
                self.harness.last_phase = Some(phase.clone());
                self.harness.last_activity = Some(short_event_text(&content));
                self.thought.chunks.push(ThoughtChunk { coordinator, phase, content });
                if self.thought.chunks.len() > 100 { self.thought.chunks.remove(0); }
                if let Some(chunk) = self.thought.chunks.last() {
                    let coordinator = chunk.coordinator.clone();
                    let phase = chunk.phase.clone();
                    let content = chunk.content.clone();
                    self.note_task_worker(task_id, &coordinator, "thinking");
                    self.route_after_worker_activity(&coordinator, &phase, "thinking", Some(&content));
                }
                self.dirty.thought = true;
                self.dirty.thought_header = true;
                self.dirty.search_results = true;
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
                });
                self.modal_focused = 0;
                self.dirty.modal = true;
            }
            BunMessage::ShowInfoModal { title, content } => {
                self.modal = ModalState::Info(InfoModalState { title, content, scroll: 0 });
                self.dirty.modal = true;
            }

            // ── Settings Hub ───────────────────────────────────────────────────
            BunMessage::SettingsData { providers, agents, mcp, skills, github_connected, github_repo, telegram_active } => {
                if let ModalState::Settings(hub) = &mut self.modal {
                    hub.providers = providers.into_iter().map(|p| SettingsProvider {
                        id: p.id, name: p.name, model: p.model,
                        is_active: p.is_active, has_key: p.has_key,
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
                self.dirty.full = true;
            }

            // ── Logs ───────────────────────────────────────────────────────────
            BunMessage::LogEntry { timestamp, level, source, message } => {
                self.logs.entries.push(LogEntry { timestamp, level, source, message });
                if self.logs.entries.len() > self.logs.capacity {
                    self.logs.entries.remove(0);
                }
                self.dirty.logs = true;
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
                self.dirty.conflicts = true;
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
                self.recommend_layout(TabId::Focus, LayoutStage::Failed, "error -> Focus");
                self.logs.entries.push(LogEntry {
                    timestamp: "ERR".to_string(),
                    level: "error".to_string(),
                    source: "ipc".to_string(),
                    message,
                });
                if self.logs.entries.len() > self.logs.capacity {
                    self.logs.entries.remove(0);
                }
                self.dirty.logs = true;
                self.dirty.history = true;
                self.dirty.full = true;
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
                self.dirty.logs = true;
                self.dirty.checkpoints = true;
            }

            // ── ADRs ───────────────────────────────────────────────────────────
            BunMessage::AdrUpdate { path, title, content, status } => {
                if let Some(e) = self.adrs.entries.iter_mut().find(|e| e.path == path) {
                    e.title = title; e.content = content; e.status = status;
                } else {
                    self.adrs.entries.push(AdrEntry { path, title, content, status });
                }
                self.dirty.adrs = true;
                self.dirty.full = true;
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
                    self.recommend_layout(TabId::Focus, LayoutStage::Failed, "plan incompleto -> Focus");
                    self.dirty.history = true;
                    self.dirty.full = true;
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
                self.dirty.full = true;
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
                self.dirty.full = true;
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
                self.dirty.full = true;
            }

            BunMessage::ResumeAvailable { task_id, checkpoint_id, reason } => {
                self.dashboard.resume = Some(ResumeInfo { task_id, checkpoint_id, reason: reason.clone() });
                self.dashboard.push_blackboard_event(BlackboardEvent {
                    timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                    agent: "system".to_string(),
                    event_type: "RESUME".to_string(),
                    content: short_event_text(&reason),
                });
                self.recommend_layout(TabId::Dashboard, LayoutStage::Failed, "checkpoint disponible para reanudar -> Dashboard");
                self.dirty.full = true;
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
                self.dirty.full = true;
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
                    self.recommend_layout(TabId::Focus, LayoutStage::Completed, "tarea completa -> Focus");
                } else if status == "failed" {
                    self.recommend_layout(TabId::Focus, LayoutStage::Failed, "tarea fallida -> Focus");
                } else {
                    let count = self.active_execution_workers().len();
                    if count >= 2 {
                        self.recommend_layout(TabId::Dashboard, LayoutStage::Executing, format!("{count} workers activos -> Dashboard"));
                    } else if count == 1 {
                        self.recommend_layout(TabId::Code, LayoutStage::Executing, "1 worker activo -> Code");
                    }
                }
                self.dirty.session = true;
                self.dirty.full = true;
            }

            // ── Aprobación del plan ─────────────────────────────────────────────
            BunMessage::PlanApprovalRequest => {
                self.harness.approval_pending = true;
                self.harness.active_task_status = Some("approval".to_string());
                self.modal = ModalState::PlanApproval(PlanApprovalState { selected: 0 });
                self.recommend_layout(TabId::Plan, LayoutStage::Planning, "plan esperando aprobación -> Plan");
                self.dirty.full = true;
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
                self.dirty.diff = true;
                self.dirty.full = true;
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
                self.dirty.workers = true;
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
                self.dirty.filemap = true;
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
        assert!(!state.history_nav_mode);
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

        assert_eq!(state.active_tab, TabId::Focus);
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

        assert_eq!(state.active_tab, TabId::Dashboard);
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

        assert_eq!(state.active_tab, TabId::Dashboard);
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

        assert_eq!(state.active_tab, TabId::Focus);
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

        assert_eq!(state.active_tab, TabId::Focus);
        assert_eq!(state.routing.recommended_tab, TabId::Focus);
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
        assert_eq!(state.routing.recommended_tab, TabId::Dashboard);
        state.resume_auto_layout();
        assert_eq!(state.active_tab, TabId::Dashboard);
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
