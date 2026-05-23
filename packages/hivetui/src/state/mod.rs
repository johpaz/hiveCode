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
mod session;
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
pub use modal::{ConfigModalState, InfoModalState, ModalField, ModalFieldKind, ModalState};
pub use session::{ReplMode, SessionState, TabId};
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
                            name,
                            status: WorkerStatus::Waiting,
                            detail: None,
                        });
                    }
                }
                self.dirty.session = true;
                self.dirty.workers = true;
                self.dirty.full = true;
            }

            // ── Respuesta del agente ───────────────────────────────────────────
            BunMessage::AssistantChunk { text } => {
                match self.history.entries.last_mut() {
                    Some(e) if e.role == Role::Assistant => e.content.push_str(&text),
                    _ => self.history.entries.push(HistoryEntry {
                        role: Role::Assistant,
                        content: text,
                    }),
                }
                self.history.selected = Some(self.history.entries.len().saturating_sub(1));
                self.dirty.history = true;
            }
            BunMessage::AssistantDone => {
                self.running = false;
                self.tab_locked = false;
                self.active_tab = TabId::Focus;
                self.dirty.full = true;
                self.dirty.history = true;
            }
            // Protocolo legado: respuesta completa en un mensaje
            BunMessage::HistoryAppend { role, content, .. } => {
                let r = Role::from(role.as_str());
                self.history.entries.push(HistoryEntry { role: r, content });
                self.history.selected = Some(self.history.entries.len().saturating_sub(1));
                if r == Role::Assistant {
                    // La respuesta llegó → detener live-activity y mostrarla ya.
                    // No esperar a Status{running:false}; tui-launcher los envía en orden
                    // pero queremos el cambio de estado en el mismo frame.
                    self.running = false;
                    if !self.tab_locked {
                        self.active_tab = TabId::Focus;
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
                    self.active_tab = TabId::Focus;
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
                            ReplMode::Plan     => TabId::Plan,
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
            BunMessage::WorkerUpdate { worker, phase, status } => {
                let wstatus = match status.as_str() {
                    "running" => WorkerStatus::Running,
                    "done"    => WorkerStatus::Done,
                    "failed"  => WorkerStatus::Failed,
                    _         => WorkerStatus::Waiting,
                };
                if let Some(w) = self.workers.workers.iter_mut().find(|w| w.name == worker) {
                    w.status = wstatus;
                    w.detail = Some(phase);
                } else {
                    self.workers.workers.push(Worker { name: worker, status: wstatus, detail: Some(phase) });
                }
                self.dirty.workers = true;
            }
            // Legado: activity_update → actualiza coordinator activo
            BunMessage::ActivityUpdate { coordinator, phase, status } => {
                // Auto-routing basado en modo, no en nombre del coordinador
                if !self.tab_locked && status == "running" {
                    self.active_tab = match self.session.mode {
                        ReplMode::Plan     => TabId::Plan,
                        ReplMode::Approval => TabId::Review,
                        ReplMode::Auto     => TabId::Code,
                    };
                    self.dirty.full = true;
                }
                self.workers.active_coordinator = coordinator;
                self.workers.active_phase = phase;
                self.workers.activity_status = status;
                self.dirty.workers = true;
            }

            // ── Checkpoints ────────────────────────────────────────────────────
            BunMessage::CheckpointCreated { id, description, file_count, agent } => {
                let time = chrono::Local::now().format("%H:%M").to_string();
                self.checkpoints.push(Checkpoint { id, description, file_count, agent, time });
                self.dirty.checkpoints = true;
            }

            // ── Mapa de riesgo ─────────────────────────────────────────────────
            BunMessage::FileRiskUpdate { path, risk, operation, agent } => {
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
                } else {
                    self.filemap.entries.push(FileEntry { path, risk: risk_level, operation, agent });
                }
                self.dirty.filemap = true;
            }

            // ── Stream de pensamiento ──────────────────────────────────────────
            BunMessage::ThoughtChunk { coordinator, phase, content } => {
                self.thought.chunks.push(ThoughtChunk { coordinator, phase, content });
                if self.thought.chunks.len() > 100 { self.thought.chunks.remove(0); }
                self.dirty.thought = true;
            }
            BunMessage::NarrativeChunk { coordinator, phase, content, .. } => {
                self.thought.chunks.push(ThoughtChunk { coordinator, phase, content });
                if self.thought.chunks.len() > 100 { self.thought.chunks.remove(0); }
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
            BunMessage::ConflictAlert { agent, file, reason, severity } => {
                self.conflicts.entries.push(AgentConflict {
                    agent,
                    path: file,
                    reason: format!("[{severity}] {reason}"),
                });
                self.dirty.conflicts = true;
            }
            BunMessage::Error { message } => {
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

            // ── Diff activo ─────────────────────────────────────────────────────
            BunMessage::FileDiff { path, chunks } => {
                self.diff.path = path;
                self.diff.lines = chunks;
                self.diff.scroll = 0;
                if !self.tab_locked {
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
                    } else {
                        self.workers.workers.push(Worker { name: w.name, status, detail: w.detail });
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
                    } else {
                        self.filemap.entries.push(FileEntry { path: f.path, risk, operation: f.operation, agent: f.agent });
                    }
                }
                self.dirty.filemap = true;
            }

            // ── No-ops ─────────────────────────────────────────────────────────
            BunMessage::Suggestions { .. }
            | BunMessage::QuickMenu { .. }
            | BunMessage::ShellOutput { .. }
            | BunMessage::Suspend
            | BunMessage::Resume
            | BunMessage::ContextUpdate { .. } => {}
        }
    }
}
