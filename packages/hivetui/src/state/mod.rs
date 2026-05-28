#![allow(dead_code)]

mod adr;
mod checkpoint;
mod conflicts;
mod diff;
mod dirty;
mod filemap;
mod history;
mod input;
mod logs;
mod modal;
mod plan;
mod session;
mod tasks;
mod thought;
mod workers;

pub use adr::{AdrEntry, AdrState};
pub use checkpoint::{Checkpoint, CheckpointState};
pub use conflicts::{AgentConflict, ConflictState};
pub use diff::DiffState;
pub use crate::ipc::DiffLine;
pub use dirty::DirtyFlags;
pub use filemap::{FileEntry, FileMapState, RiskLevel};
pub use history::{HistoryEntry, HistoryState, Role};
pub use input::InputState;
pub use logs::{LogEntry, LogState};
pub use modal::{ConfigModalState, InfoModalState, ModalField, ModalFieldKind, ModalState, PlanApprovalState};
pub use plan::{PlanEntry, PlanPhase, PlanRisk, PlanState};
pub use session::{ReplMode, SessionState, TabId};
pub use tasks::{TaskProjection, TaskProjectionState};
pub use thought::{ThoughtChunk, ThoughtStreamState};
pub use workers::{Worker, WorkerState, WorkerStatus};

#[derive(Debug, Default)]
pub struct AppState {
    pub session: SessionState,
    pub input: InputState,
    pub history: HistoryState,
    pub checkpoints: CheckpointState,
    pub workers: WorkerState,
    pub filemap: FileMapState,
    pub thought: ThoughtStreamState,
    pub conflicts: ConflictState,
    pub adrs: AdrState,
    pub diff: DiffState,
    pub plan: PlanState,
    pub tasks: TaskProjectionState,
    pub modal: ModalState,
    pub logs: LogState,
    pub dirty: DirtyFlags,
    pub cursor_visible: bool,
    pub history_nav_mode: bool,
    pub history_hscroll: usize,
    pub history_hscroll_per_entry: std::collections::HashMap<usize, usize>,
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
    /// true cuando el usuario navegó manualmente (1-5), inhibe auto-routing hasta AssistantDone.
    pub tab_locked: bool,
}

impl AppState {
    fn note_task_worker(&mut self, task_id: Option<String>, worker: &str, status: &str) {
        let Some(task_id) = task_id.filter(|task_id| !task_id.trim().is_empty()) else {
            return;
        };
        self.tasks.mark_worker(task_id, worker.to_string(), status);
        self.session.task_count = self.session.task_count.max(self.tasks.tasks.len() as u32);
        self.dirty.session = true;
        self.dirty.full = true;
    }

    pub fn apply_message(&mut self, msg: crate::ipc::BunMessage) {
        use crate::ipc::BunMessage;
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
                        self.workers.workers.push(Worker {
                            name: name.clone(),
                            display_name: name.clone(),
                            status: WorkerStatus::Waiting,
                            detail: None,
                            activity: None,
                        });
                    }
                }
                self.dirty.session = true;
                self.dirty.workers = true;
                self.dirty.full = true;
            }

            // ── Respuesta del agente ───────────────────────────────────────────
            BunMessage::AssistantChunk { text, agent, timestamp } => {
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
                self.history.scroll = 0;
                self.tab_locked = false;
                self.active_tab = if self.session.mode == ReplMode::Plan && self.plan.current.is_some() {
                    TabId::Plan
                } else {
                    TabId::Focus
                };
                self.dirty.full = true;
                self.dirty.history = true;
            }
            // Protocolo legado: respuesta completa en un mensaje
            BunMessage::HistoryAppend { role, content, agent, timestamp, .. } => {
                let r = Role::from(role.as_str());
                self.history.entries.push(HistoryEntry { role: r, content, agent, timestamp });
                self.history.scroll = 0;
                self.history.selected = Some(self.history.entries.len().saturating_sub(1));
                if r == Role::Assistant {
                    // La respuesta llegó → detener live-activity y mostrarla ya.
                    // No esperar a Status{running:false}; tui-launcher los envía en orden
                    // pero queremos el cambio de estado en el mismo frame.
                    self.running = false;
                    if !self.tab_locked {
                        self.active_tab = if self.session.mode == ReplMode::Plan && self.plan.current.is_some() {
                            TabId::Plan
                        } else {
                            TabId::Focus
                        };
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
                // Cuando la tarea termina (running: true → false) ir a Focus igual que AssistantDone.
                // Esto maneja el protocolo del tui-launcher que usa Status en vez de AssistantDone.
                if was_running && !running && !self.tab_locked {
                    self.active_tab = if self.session.mode == ReplMode::Plan && self.plan.current.is_some() {
                        TabId::Plan
                    } else {
                        TabId::Focus
                    };
                    self.tab_locked = false;
                    self.dirty.full = true;
                }
                self.dirty.session = true;
            }
            BunMessage::StateUpdate { new_mode, new_provider, new_model } => {
                if let Some(m) = new_mode {
                    self.session.mode = ReplMode::from(m.as_str());
                    // Al cambiar de modo, navegar al layout correspondiente
                    if !self.tab_locked {
                        self.active_tab = match self.session.mode {
                            ReplMode::Plan     => {
                                self.plan.current = None;
                                self.plan.scroll = 0;
                                TabId::Focus
                            }
                            ReplMode::Approval => TabId::Review,
                            ReplMode::Auto     => TabId::Focus,
                        };
                    }
                    self.dirty.full = true;
                }
                if let Some(p) = new_provider { self.session.provider = p; }
                if let Some(m) = new_model { self.session.model = m; }
                self.dirty.session = true;
            }

            // ── Workers ────────────────────────────────────────────────────────
            BunMessage::WorkerUpdate { task_id, worker, phase, status, display_name, activity } => {
                let wstatus = match status.as_str() {
                    "running" => WorkerStatus::Running,
                    "done"    => WorkerStatus::Done,
                    "failed"  => WorkerStatus::Failed,
                    "warn"    => WorkerStatus::Warn,
                    _         => WorkerStatus::Waiting,
                };
                if let Some(w) = self.workers.workers.iter_mut().find(|w| w.name == worker) {
                    w.status = wstatus;
                    w.detail = Some(phase.clone());
                    if let Some(dn) = display_name { w.display_name = dn; }
                    if let Some(act) = activity { w.activity = Some(act); }
                } else {
                    self.workers.workers.push(Worker {
                        name: worker.clone(),
                        display_name: display_name.unwrap_or(worker.clone()),
                        status: wstatus,
                        detail: Some(phase),
                        activity,
                    });
                }
                // Auto-routing: only switch tab when a real executor worker starts, not BEE
                if !self.tab_locked && status == "running" && worker != "bee" {
                    if self.session.mode != ReplMode::Plan {
                        self.active_tab = match self.session.mode {
                            ReplMode::Approval => TabId::Review,
                            ReplMode::Auto     => TabId::Code,
                            ReplMode::Plan     => unreachable!(),
                        };
                        self.dirty.full = true;
                    }
                }
                self.note_task_worker(task_id, &worker, &status);
                self.dirty.workers = true;
            }
            // Legado: activity_update → actualiza coordinator activo
            BunMessage::ActivityUpdate { task_id, coordinator, phase, status, display_name, activity } => {
                // Auto-routing: only switch tab when a real executor coordinator starts, not BEE
                if !self.tab_locked && status == "running" && coordinator != "bee" {
                    if self.session.mode != ReplMode::Plan {
                        self.active_tab = match self.session.mode {
                            ReplMode::Approval => TabId::Review,
                            ReplMode::Auto     => TabId::Code,
                            ReplMode::Plan     => unreachable!(),
                        };
                        self.dirty.full = true;
                    }
                }
                self.workers.active_coordinator = coordinator.clone();
                self.workers.active_phase = phase.clone();
                self.workers.activity_status = status.clone();
                if let Some(w) = self.workers.workers.iter_mut().find(|w| w.name == coordinator) {
                    if let Some(dn) = display_name { w.display_name = dn; }
                    if let Some(act) = activity { w.activity = Some(act); }
                }
                self.note_task_worker(task_id, &coordinator, &status);
                self.dirty.workers = true;
            }

            // ── Checkpoints ────────────────────────────────────────────────────
            BunMessage::CheckpointCreated { id, description, file_count, agent, tests_passed, tests_total } => {
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
                self.thought.chunks.push(ThoughtChunk { coordinator, phase, content });
                if self.thought.chunks.len() > 100 { self.thought.chunks.remove(0); }
                if let Some(chunk) = self.thought.chunks.last() {
                    let coordinator = chunk.coordinator.clone();
                    self.note_task_worker(task_id, &coordinator, "thinking");
                }
                self.dirty.thought = true;
            }
            BunMessage::NarrativeChunk { task_id, coordinator, phase, content, .. } => {
                self.thought.chunks.push(ThoughtChunk { coordinator, phase, content });
                if self.thought.chunks.len() > 100 { self.thought.chunks.remove(0); }
                if let Some(chunk) = self.thought.chunks.last() {
                    let coordinator = chunk.coordinator.clone();
                    self.note_task_worker(task_id, &coordinator, "thinking");
                }
                self.dirty.thought = true;
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
                if !self.tab_locked {
                    self.active_tab = TabId::Focus;
                }
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
            BunMessage::PlanUpdate { task_id, adr_title, adr_content, status, phases, risks } => {
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
                    if !self.tab_locked {
                        self.active_tab = TabId::Focus;
                    }
                    self.dirty.history = true;
                    self.dirty.full = true;
                    return;
                }
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
                });
                self.plan.selected_phase = 0;
                self.plan.scroll = 0;
                if !self.tab_locked {
                    self.active_tab = TabId::Plan;
                    self.history_nav_mode = false;
                    self.history_hscroll = 0;
                }
                self.dirty.full = true;
            }

            // ── Proyección de tareas ────────────────────────────────────────────
            BunMessage::TaskUpdate { task_id, title, status, mode, active_workers } => {
                self.tasks.upsert(task_id, title, status, mode, active_workers);
                self.session.task_count = self.session.task_count.max(self.tasks.tasks.len() as u32);
                self.dirty.session = true;
                self.dirty.full = true;
            }

            // ── Aprobación del plan ─────────────────────────────────────────────
            BunMessage::PlanApprovalRequest => {
                self.modal = ModalState::PlanApproval(PlanApprovalState { selected: 0 });
                if !self.tab_locked { self.active_tab = TabId::Plan; }
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
                // Only auto-route to Code when not in Plan mode (plan tab takes priority)
                if !self.tab_locked && self.session.mode != ReplMode::Plan {
                    self.active_tab = TabId::Code;
                }
                self.dirty.diff = true;
                self.dirty.full = true;
            }

            // ── Snapshots de inicio (SQLite → IPC) ─────────────────────────────
            BunMessage::WorkersSnapshot { workers } => {
                for w in workers {
                    let status = match w.status.as_str() {
                        "running" => WorkerStatus::Running,
                        "done"    => WorkerStatus::Done,
                        "failed"  => WorkerStatus::Failed,
                        _         => WorkerStatus::Waiting,
                    };
                    if let Some(existing) = self.workers.workers.iter_mut().find(|x| x.name == w.name) {
                        existing.status = status;
                        existing.detail = w.detail;
                        if let Some(ref dn) = w.display_name { existing.display_name = dn.clone(); }
                        if let Some(ref act) = w.activity { existing.activity = Some(act.clone()); }
                    } else {
                        self.workers.workers.push(Worker {
                            name: w.name.clone(),
                            display_name: w.display_name.unwrap_or(w.name.clone()),
                            status,
                            detail: w.detail,
                            activity: w.activity,
                        });
                    }
                }
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

            // ── Shell output de workers ────────────────────────────────────────
            BunMessage::ShellOutput { stdout, stderr, exit_code } => {
                let combined = match (stdout.is_empty(), stderr.is_empty()) {
                    (false, false) => format!("{stdout}\n[stderr] {stderr}"),
                    (false, true)  => stdout,
                    (true,  false) => format!("[stderr] {stderr}"),
                    (true,  true)  => return,
                };
                let phase = if exit_code == 0 { "shell".to_string() } else { format!("exit:{exit_code}") };
                for line in combined.lines().take(10) {
                    if line.trim().is_empty() { continue; }
                    self.thought.chunks.push(ThoughtChunk {
                        coordinator: "shell".to_string(),
                        phase: phase.clone(),
                        content: line.to_string(),
                    });
                }
                if self.thought.chunks.len() > 100 {
                    let excess = self.thought.chunks.len() - 100;
                    self.thought.chunks.drain(0..excess);
                }
                self.dirty.thought = true;
            }

            // ── No-ops ─────────────────────────────────────────────────────────
            BunMessage::Suggestions { .. }
            | BunMessage::QuickMenu { .. }
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
    fn plan_mode_stays_in_focus_until_structured_plan_arrives() {
        let mut state = AppState::default();

        state.apply_message(BunMessage::StateUpdate {
            new_mode: Some("plan".to_string()),
            new_provider: None,
            new_model: None,
        });
        state.apply_message(BunMessage::ActivityUpdate {
            task_id: None,
            coordinator: "architecture".to_string(),
            phase: "reading".to_string(),
            status: "running".to_string(),
            display_name: None,
            activity: None,
        });

        assert_eq!(state.active_tab, TabId::Focus);
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
    fn task_update_tracks_active_projection_without_changing_tab() {
        let mut state = AppState::default();

        state.apply_message(BunMessage::TaskUpdate {
            task_id: "task-1".to_string(),
            title: Some("Corregir login".to_string()),
            status: "running".to_string(),
            mode: Some("auto".to_string()),
            active_workers: Some(vec!["backend".to_string(), "test".to_string()]),
        });

        assert_eq!(state.active_tab, TabId::Focus);
        assert_eq!(state.tasks.active_task_id.as_deref(), Some("task-1"));
        assert_eq!(state.tasks.tasks[0].title, "Corregir login");
        assert_eq!(state.tasks.tasks[0].active_workers.len(), 2);
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
        });

        assert!(state.tasks.tasks[0].active_workers.is_empty());
        assert_eq!(state.tasks.tasks[0].status, "running");
    }
}
