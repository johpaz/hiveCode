#![allow(dead_code)]

mod checkpoint;
mod conflicts;
mod dirty;
mod filemap;
mod history;
mod input;
mod logs;
mod modal;
mod session;
mod thought;
mod workers;

pub use checkpoint::{Checkpoint, CheckpointState};
pub use conflicts::{AgentConflict, ConflictState};
pub use dirty::DirtyFlags;
pub use filemap::{FileEntry, FileMapState, RiskLevel};
pub use history::{HistoryEntry, HistoryState, Role};
pub use input::InputState;
pub use logs::{LogEntry, LogState};
pub use modal::{ConfigModalState, InfoModalState, ModalField, ModalFieldKind, ModalState};
pub use session::{ReplMode, SessionState};
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
                if let Some(m) = mode        { self.session.mode         = ReplMode::from(m.as_str()); }
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
                self.dirty.history = true;
            }
            // Protocolo legado: respuesta completa en un mensaje
            BunMessage::HistoryAppend { role, content, .. } => {
                let r = Role::from(role.as_str());
                self.history.entries.push(HistoryEntry { role: r, content });
                self.history.selected = Some(self.history.entries.len().saturating_sub(1));
                self.dirty.history = true;
            }

            // ── Estado de sesión ───────────────────────────────────────────────
            BunMessage::Status { running, msg } => {
                self.running = running;
                self.status_msg = msg;
                self.dirty.session = true;
            }
            BunMessage::StateUpdate { new_mode, new_provider, new_model } => {
                if let Some(m) = new_mode { self.session.mode = ReplMode::from(m.as_str()); }
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
                self.workers.active_coordinator = coordinator;
                self.workers.active_phase = phase;
                self.workers.activity_status = status;
                self.dirty.workers = true;
            }

            // ── Checkpoints ────────────────────────────────────────────────────
            BunMessage::CheckpointCreated { id, description, file_count, agent } => {
                self.checkpoints.push(Checkpoint { id, description, file_count, agent });
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
                    .map(|f| f.default_value.clone().unwrap_or_default())
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

            // ── Alertas ────────────────────────────────────────────────────────
            BunMessage::ConflictAlert { worker_a, worker_b, file } => {
                self.conflicts.entries.push(AgentConflict {
                    agent: format!("{worker_a}↔{worker_b}"),
                    path: file,
                    reason: "file collision".to_string(),
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
        }
    }
}
