use arboard;
use base64::Engine;
use color_eyre::eyre::Result;
use crossterm::{
    event::{
        Event, EventStream, KeyCode, KeyEvent, KeyEventKind,
        KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::StreamExt;
use ratatui::{backend::CrosstermBackend, layout::Rect, widgets::ListItem, Terminal};
use std::io::{stdout, Write};
use tokio::sync::mpsc::Sender;

use crate::ipc::{self, BunMessage, ModalField, MenuItem, TuiMessage};
use crate::screens;

// ── Color palette ────────────────────────────────────────────────────────────

pub const AMBER: ratatui::style::Color = ratatui::style::Color::Indexed(214);
pub const AMBER_DIM: ratatui::style::Color = ratatui::style::Color::Indexed(136);
pub const GREEN: ratatui::style::Color = ratatui::style::Color::Indexed(114);
pub const RED: ratatui::style::Color = ratatui::style::Color::Indexed(203);
pub const PURPLE: ratatui::style::Color = ratatui::style::Color::Indexed(141);
pub const BLUE: ratatui::style::Color = ratatui::style::Color::Indexed(75);
pub const CYAN: ratatui::style::Color = ratatui::style::Color::Indexed(45);
pub const DIM: ratatui::style::Color = ratatui::style::Color::Indexed(240);
pub const SECONDARY: ratatui::style::Color = ratatui::style::Color::Indexed(248);

// ── State module re-exports (source of truth lives in state/) ────────────────
// Widgets import from `crate::app::*`; these re-exports keep that working while
// the canonical definitions live in their dedicated modules.
#[allow(unused_imports)]
pub use crate::state::{
    AdrRisk, AdrState,
    CheckpointEntry, CheckpointState,
    DirtyFlags,
    FileMapState, FileRiskEntry,
    LogState,
    ModalState,
    NarrativeChunk, ThoughtStreamState,
    Phase, WorkerState,
};

// ── Domain types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplMode {
    Plan,
    Approval,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MascotState {
    Welcome,      // \(^•^)/   happy, wings up
    Thinking,     // (~•~)     squinted eyes, animated
    Searching,    // (o•-)     scanning left/right, animated
    Reading,      // (^•^)     reading, animated
    Writing,      // (>•<)     writing, animated
    Executing,    // (•̀ᴗ•́)   executing, animated
    Completed,    // (★•★)     star eyes
    Error,        // (x•x)     X eyes, red
    Idle,         // (-•-)     sleeping, gray
    PlanMode,     // (o•o)     open eyes, observing
    Approval,     // (?•?)     waiting for user decision
}

impl ReplMode {
    pub fn label(&self) -> &'static str {
        match self {
            ReplMode::Plan => "PLAN",
            ReplMode::Approval => "APROBACIÓN",
            ReplMode::Auto => "AUTO",
        }
    }

    pub fn next(&self) -> ReplMode {
        match self {
            ReplMode::Plan => ReplMode::Approval,
            ReplMode::Approval => ReplMode::Auto,
            ReplMode::Auto => ReplMode::Plan,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ReplMode::Plan => "plan",
            ReplMode::Approval => "approval",
            ReplMode::Auto => "auto",
        }
    }
}

impl From<&str> for ReplMode {
    fn from(s: &str) -> Self {
        match s {
            "approval" => ReplMode::Approval,
            "auto" => ReplMode::Auto,
            _ => ReplMode::Plan,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
    Shell,
    Thinking,
}

impl From<&str> for Role {
    fn from(s: &str) -> Self {
        match s {
            "user" => Role::User,
            "system" => Role::System,
            "shell" => Role::Shell,
            "thinking" => Role::Thinking,
            _ => Role::Assistant,
        }
    }
}

#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub role: Role,
    pub content: String,
    pub content_type: crate::markdown::ContentType,
    pub thinking_meta: Option<crate::markdown::ThinkingMeta>,
}

#[allow(dead_code)]
impl HistoryEntry {
    pub fn plain(role: Role, content: String) -> Self {
        Self { role, content, content_type: crate::markdown::ContentType::Plain, thinking_meta: None }
    }
    pub fn markdown(role: Role, content: String) -> Self {
        Self { role, content, content_type: crate::markdown::ContentType::Markdown, thinking_meta: None }
    }
    pub fn thinking(role: Role, content: String, meta: Option<crate::markdown::ThinkingMeta>) -> Self {
        Self { role, content, content_type: crate::markdown::ContentType::Thinking, thinking_meta: meta }
    }
    pub fn auto(role: Role, content: String) -> Self {
        let content_type = if crate::markdown::is_likely_markdown(&content) {
            crate::markdown::ContentType::Markdown
        } else {
            crate::markdown::ContentType::Plain
        };
        Self { role, content, content_type, thinking_meta: None }
    }
}

#[derive(Debug, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

// ── Input with cursor ────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct InputState {
    pub chars: Vec<char>,
    pub cursor: usize,
}

impl InputState {
    pub fn value(&self) -> String {
        self.chars.iter().collect()
    }

    pub fn clear(&mut self) {
        self.chars.clear();
        self.cursor = 0;
    }

    pub fn set(&mut self, s: &str) {
        self.chars = s.chars().collect();
        self.cursor = self.chars.len();
    }

    pub fn handle_key(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char(c) => {
                self.chars.insert(self.cursor, c);
                self.cursor += 1;
            }
            KeyCode::Backspace if self.cursor > 0 => {
                self.cursor -= 1;
                self.chars.remove(self.cursor);
            }
            KeyCode::Delete if self.cursor < self.chars.len() => {
                self.chars.remove(self.cursor);
            }
            KeyCode::Left if self.cursor > 0 => self.cursor -= 1,
            KeyCode::Right if self.cursor < self.chars.len() => self.cursor += 1,
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.chars.len(),
            _ => {}
        }
    }
}

// ── Application state ────────────────────────────────────────────────────────

pub struct AppState {
    pub mode: ReplMode,
    pub provider: String,
    pub model: String,
    pub project_name: String,
    pub project_path: String,
    pub session_id: String,
    pub version: String,
    pub task_count: u32,
    pub token_count: u64,
    pub workers: Vec<String>,
    pub history: Vec<HistoryEntry>,
    pub input: InputState,
    pub running: bool,
    pub status_msg: String,
    pub suggestions: Vec<String>,
    pub popup_sel: usize,
    pub show_popup: bool,
    pub quick_menu: Vec<MenuItem>,
    pub quick_menu_sel: usize,
    pub should_quit: bool,
    pub cursor_visible: bool,
    pub shell_mode: bool,
    pub active_coordinator: String,
    pub active_phase: String,
    pub activity_status: String,
    pub popup_area: Option<Rect>,
    pub mascot_state: MascotState,
    pub animation_frame: u8,
    pub show_logs: bool,
    pub show_timeline: bool,
    pub log_entries: Vec<LogEntry>,
    pub narrative_chunks: Vec<(String, String, String)>, // (coordinator, phase, content)
    pub phases: Vec<Phase>,
    pub clipboard_feedback: Option<(String, std::time::Instant)>,
    // ─── Copy mode ───
    pub copy_mode: bool,
    pub copy_sel: usize,
    pub paused: bool,
    // ─── Config modal ───
    pub show_modal: bool,
    pub modal_title: String,
    pub modal_command: String,
    pub modal_fields: Vec<ModalField>,
    pub modal_values: Vec<String>,
    pub modal_cursors: Vec<usize>,
    pub modal_focused: usize,
    pub modal_errors: Vec<bool>,
    // ─── Info modal (read-only display) ───
    pub show_info_modal: bool,
    pub info_modal_title: String,
    pub info_modal_content: String,
    pub info_scroll_offset: usize,
    // ─── History render cache (avoids per-keystroke markdown re-parse) ───
    pub history_render_cache: Vec<ListItem<'static>>,
    pub history_render_key: (usize, usize, bool, usize), // (history.len, width, copy_mode, copy_sel)
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            mode: ReplMode::Plan,
            provider: String::new(),
            model: String::new(),
            project_name: "hiveCode".to_string(),
            project_path: std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            session_id: String::new(),
            version: "1.0.0".to_string(),
            task_count: 0,
            token_count: 0,
            workers: Vec::new(),
            history: Vec::new(),
            input: InputState::default(),
            running: false,
            status_msg: "Listo · [shift+tab] cambiar modo".to_string(),
            suggestions: Vec::new(),
            popup_sel: 0,
            show_popup: false,
            quick_menu: Vec::new(),
            quick_menu_sel: 0,
            should_quit: false,
            cursor_visible: true,
            shell_mode: false,
            active_coordinator: String::new(),
            active_phase: String::new(),
            activity_status: "idle".to_string(),
            popup_area: None,
            mascot_state: MascotState::Welcome,
            animation_frame: 0,
            show_logs: false,
            show_timeline: false,
            log_entries: Vec::new(),
            narrative_chunks: Vec::new(),
            clipboard_feedback: None,
            copy_mode: false,
            copy_sel: 0,
            paused: false,
            show_modal: false,
            modal_title: String::new(),
            modal_command: String::new(),
            modal_fields: Vec::new(),
            modal_values: Vec::new(),
            modal_cursors: Vec::new(),
            modal_focused: 0,
            modal_errors: Vec::new(),
            show_info_modal: false,
            info_modal_title: String::new(),
            info_modal_content: String::new(),
            info_scroll_offset: 0,
            history_render_cache: Vec::new(),
            history_render_key: (0, 0, false, 0),
            phases: vec![
                Phase { name: "Analyze & Route".into(), coordinator: "bee".into(), status: "idle".into(), duration_ms: None },
                Phase { name: "Architecture Design".into(), coordinator: "architecture".into(), status: "idle".into(), duration_ms: None },
                Phase { name: "Backend Implementation".into(), coordinator: "backend".into(), status: "idle".into(), duration_ms: None },
                Phase { name: "Frontend Implementation".into(), coordinator: "frontend".into(), status: "idle".into(), duration_ms: None },
                Phase { name: "Security Audit".into(), coordinator: "security".into(), status: "idle".into(), duration_ms: None },
                Phase { name: "Testing".into(), coordinator: "test".into(), status: "idle".into(), duration_ms: None },
                Phase { name: "DevOps Deploy".into(), coordinator: "devops".into(), status: "idle".into(), duration_ms: None },
            ],
        }
    }
}

impl AppState {
    pub fn coordinator_color(&self) -> ratatui::style::Color {
        match self.active_coordinator.as_str() {
            "bee" => AMBER,
            "architecture" => PURPLE,
            "backend" => BLUE,
            "frontend" => GREEN,
            "security" => RED,
            "test" => ratatui::style::Color::Rgb(252, 211, 77), // yellow
            "devops" => DIM,
            _ => AMBER,
        }
    }

    pub fn update_mascot_state(&mut self) {
        self.mascot_state = if self.status_msg.contains("Error") || self.status_msg.contains("(×ᴗ×)") {
            MascotState::Error
        } else if self.activity_status == "idle" || self.active_coordinator.is_empty() {
            if self.history.is_empty() {
                MascotState::Welcome
            } else if self.running {
                MascotState::Completed
            } else {
                match self.mode {
                    ReplMode::Plan => MascotState::PlanMode,
                    _ => MascotState::Idle,
                }
            }
        } else {
            match self.activity_status.as_str() {
                "searching" => MascotState::Searching,
                "reading"   => MascotState::Reading,
                "writing"   => MascotState::Writing,
                "executing" => MascotState::Executing,
                "done"      => MascotState::Completed,
                "error"     => MascotState::Error,
                "waiting"   => MascotState::Approval,
                _           => MascotState::Thinking,
            }
        };
    }

    pub fn apply_message(&mut self, msg: BunMessage) {
        match msg {
            BunMessage::Init {
                mode, provider, model, project_name, project_path, session_id,
                version, task_count, token_count, workers,
            } => {
                self.mode = ReplMode::from(mode.as_str());
                self.provider = provider;
                self.model = model;
                self.project_name = project_name;
                self.project_path = project_path;
                self.session_id = session_id;
                self.version = version;
                self.task_count = task_count;
                self.token_count = token_count;
                self.workers = workers;
            }
            BunMessage::HistoryAppend { role, content, content_type } => {
                let r = Role::from(role.as_str());
                let is_agent_response = r == Role::Assistant || r == Role::System;
                if !content.is_empty() {
                    let ct = match content_type.as_deref() {
                        Some("markdown") => crate::markdown::ContentType::Markdown,
                        Some("thinking") => crate::markdown::ContentType::Thinking,
                        Some("plain") => crate::markdown::ContentType::Plain,
                        _ => crate::markdown::ContentType::Plain,
                    };
                    self.history.push(HistoryEntry {
                        role: r,
                        content,
                        content_type: ct,
                        thinking_meta: None,
                    });
                }
                // Safety: unlock input when the agent's response arrives,
                // in case the Status message is lost or arrives out of order.
                if is_agent_response {
                    self.running = false;
                    self.update_mascot_state();
                }
            }
            BunMessage::Status { running, msg } => {
                self.running = running;
                self.status_msg = msg;
                self.update_mascot_state();
            }
            BunMessage::StateUpdate { new_mode, new_provider, new_model } => {
                if let Some(m) = new_mode {
                    self.mode = ReplMode::from(m.as_str());
                }
                if let Some(p) = new_provider {
                    self.provider = p;
                }
                if let Some(m) = new_model {
                    self.model = m;
                }
            }
            BunMessage::Suggestions { items } => {
                eprintln!("[app] Got suggestions: {} items", items.len());
                self.suggestions = items;
                self.popup_sel = 0;
                self.show_popup = !self.suggestions.is_empty();
            }
            BunMessage::QuickMenu { items } => {
                self.quick_menu = items;
                self.quick_menu_sel = 0;
            }
            BunMessage::ShellOutput { stdout, stderr, exit_code } => {
                self.running = false;
                let mut content = String::new();
                if !stdout.is_empty() {
                    content.push_str(&stdout);
                }
                if !stderr.is_empty() {
                    if !content.is_empty() { content.push('\n'); }
                    content.push_str(&stderr);
                }
                if content.is_empty() {
                    content = format!("(código de salida: {})", exit_code);
                }
                self.history.push(HistoryEntry::plain(Role::Shell, content));
                self.status_msg = format!("Shell · exit {}", exit_code);
            }
            BunMessage::ActivityUpdate { coordinator, phase, status } => {
                self.active_coordinator = coordinator.clone();
                self.active_phase = phase.clone();
                self.activity_status = status.clone();
                if !coordinator.is_empty() {
                    self.status_msg = format!("{} · {}", coordinator, status);
                }
                // Update phase timeline
                for p in &mut self.phases {
                    if p.coordinator == coordinator {
                        p.status = status.clone();
                        p.name = phase.clone();
                    }
                }
                self.update_mascot_state();
            }
            BunMessage::LogEntry { timestamp, level, source, message } => {
                self.log_entries.push(LogEntry {
                    timestamp,
                    level,
                    source,
                    message,
                });
                if self.log_entries.len() > 500 {
                    self.log_entries.remove(0);
                }
            }
            BunMessage::NarrativeChunk { coordinator, phase, content, content_type: _, stream_id: _ } => {
                self.narrative_chunks.push((coordinator.clone(), phase.clone(), content.clone()));
                if self.narrative_chunks.len() > 100 {
                    self.narrative_chunks.remove(0);
                }
                // Update mascot state but do NOT add to conversation history —
                // activity_update already drives the status bar, and history_append
                // sends the final clean response. Adding chunks here caused duplicates.
                if phase == "thinking" {
                    self.mascot_state = MascotState::Thinking;
                }
            }
            BunMessage::ShowConfigModal { command, title, fields } => {
                let n = fields.len();
                self.modal_command = command;
                self.modal_title = title;
                // Initialize values from default_value, or first option for selects
                let values: Vec<String> = fields.iter().map(|f| {
                    if let Some(ref dv) = f.default_value {
                        return dv.clone();
                    }
                    if f.field_type == "select" {
                        return f.options.as_ref().and_then(|o| o.first().cloned()).unwrap_or_default();
                    }
                    String::new()
                }).collect();
                self.modal_fields = fields;
                self.modal_values = values;
                self.modal_cursors = vec![0; n];
                self.modal_errors = vec![false; n];
                self.modal_focused = 0;
                self.show_modal = true;
                self.running = false;
                self.status_msg = "Tab navegar · Ctrl+S guardar · Esc cancelar".to_string();
            }
            BunMessage::ShowInfoModal { title, content } => {
                self.show_info_modal = true;
                self.info_modal_title = title;
                self.info_modal_content = content;
                self.info_scroll_offset = 0;
                self.running = false;
                self.status_msg = "Esc cerrar · ↑↓ scroll".to_string();
            }
            BunMessage::ConflictAlert { agent, file, reason, severity } => {
                let msg = format!("⚠ CONFLICT [{severity}] {agent} ← {file}: {reason}");
                self.status_msg = msg.clone();
                self.history.push(HistoryEntry::plain(Role::System, msg));
            }
            BunMessage::FileRiskUpdate { path, risk, reason, .. } => {
                let msg = format!("🔴 RISK [{risk}] {path}: {reason}");
                self.status_msg = msg;
            }
            BunMessage::CheckpointCreated { description, file_count, .. } => {
                self.status_msg = format!("💾 checkpoint: {description} ({file_count} files)");
            }
            BunMessage::CheckpointRollback { files_restored, .. } => {
                self.status_msg = format!("⏮ rollback: {files_restored} files restored");
            }
            BunMessage::ContextUpdate { agent, key, .. } => {
                self.status_msg = format!("📋 {agent} updated context: {key}");
            }
            // Handled in the main loop before apply_message is called
            BunMessage::Suspend | BunMessage::Resume => {}
        }
    }

    pub fn handle_key(
        &mut self,
        key: KeyEvent,
        ipc_tx: &Sender<TuiMessage>,
    ) {
        // Ctrl+Y — copy history to clipboard (works in any state)
        if key.code == KeyCode::Char('y') && key.modifiers.contains(KeyModifiers::CONTROL) {
            let text = crate::widgets::history::get_text(&self.history);
            let msg = match copy_to_clipboard(&text) {
                Ok(_)  => "✅ Copiado al portapapeles".to_string(),
                Err(e) => format!("⚠ Portapapeles: {}", e),
            };
            self.clipboard_feedback = Some((msg, std::time::Instant::now()));
            return;
        }

        // Ctrl+K — toggle copy mode
        if key.code == KeyCode::Char('k') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.copy_mode = !self.copy_mode;
            if self.copy_mode && !self.history.is_empty() {
                self.copy_sel = self.history.len().saturating_sub(1);
            }
            self.status_msg = if self.copy_mode {
                "Modo copia: ↑↓ navegar · Enter copiar · Esc salir".to_string()
            } else {
                "Listo · [shift+tab] cambiar modo".to_string()
            };
            return;
        }

        // Ctrl+B — copy last assistant response
        if key.code == KeyCode::Char('b') && key.modifiers.contains(KeyModifiers::CONTROL) {
            if let Some(entry) = self.history.iter().rev().find(|e| matches!(e.role, Role::Assistant | Role::Thinking)) {
                let text = &entry.content;
                let msg = match copy_to_clipboard(text) {
                    Ok(_)  => "✅ Respuesta copiada al portapapeles".to_string(),
                    Err(e) => format!("⚠ Portapapeles: {}", e),
                };
                self.clipboard_feedback = Some((msg, std::time::Instant::now()));
            } else {
                self.clipboard_feedback = Some(("⚠ No hay respuestas del asistente".to_string(), std::time::Instant::now()));
            }
            return;
        }

        if self.copy_mode {
            self.handle_copy_mode_key(key, ipc_tx);
            return;
        }

        if self.show_info_modal {
            self.handle_info_modal_key(key, ipc_tx);
            return;
        }

        if self.show_modal {
            self.handle_modal_key(key, ipc_tx);
            return;
        }

        if self.show_popup {
            self.handle_popup_key(key, ipc_tx);
            return;
        }

        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                let _ = ipc_tx.try_send(TuiMessage::Exit);
                self.should_quit = true;
            }
            KeyCode::Enter if !self.running => {
                let input = self.input.value();
                if !input.trim().is_empty() {
                    self.history.push(HistoryEntry::plain(if self.shell_mode { Role::Shell } else { Role::User }, input.clone()));
                    self.input.clear();
                    self.running = true;
                    self.show_popup = false;
                    self.suggestions.clear();
                    if self.shell_mode {
                        self.status_msg = "Ejecutando shell...".to_string();
                        let _ = ipc_tx.try_send(TuiMessage::ShellExecute { command: input });
                    } else {
                        self.status_msg = "Procesando...".to_string();
                        let _ = ipc_tx.try_send(TuiMessage::Submit { input });
                    }
                }
            }
            KeyCode::BackTab => {
                // Shift+Tab — cycle mode
                self.mode = self.mode.next();
                self.status_msg = format!("Modo: {}", self.mode.label());
                let mode_str = self.mode.as_str().to_string();
                let _ = ipc_tx.try_send(TuiMessage::ModeChange { mode: mode_str });
            }
            KeyCode::Char('x') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.shell_mode = !self.shell_mode;
                self.status_msg = if self.shell_mode {
                    "Shell mode — escribe comandos de shell".to_string()
                } else {
                    "Agent mode — escribe tareas o /comandos".to_string()
                };
            }
            KeyCode::Char('l') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.show_logs = !self.show_logs;
                self.status_msg = if self.show_logs {
                    "Panel de logs activo [Ctrl+L para cerrar]".to_string()
                } else {
                    "Listo · [shift+tab] cambiar modo".to_string()
                };
            }
            KeyCode::Char('m') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.paused = true;
                self.status_msg = "\x1b[1;33m[ PAUSA ] Selecciona texto con el mouse. Presiona Enter para volver \x1b[0m".to_string();
            }
            KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.show_timeline = !self.show_timeline;
                self.status_msg = if self.show_timeline {
                    "Timeline de fases activo [Ctrl+P para cerrar]".to_string()
                } else {
                    "Listo · [shift+tab] cambiar modo".to_string()
                };
            }
            KeyCode::Esc => {
                self.show_popup = false;
                self.suggestions.clear();
                self.popup_sel = 0;
            }
            _ => {
                // Allow typing even while agent is running — buffered for the next submit.
                // Only Enter is blocked (guarded above with !self.running).
                let before = self.input.value();
                self.input.handle_key(key.code);
                let after = self.input.value();

                if before != after {
                    if !self.running && after.starts_with('/') {
                        let _ = ipc_tx.try_send(TuiMessage::SuggestionsRequest {
                            query: after.clone(),
                        });
                    } else {
                        self.show_popup = false;
                        self.suggestions.clear();
                    }
                }
            }
        }
    }

    fn handle_popup_key(&mut self, key: KeyEvent, ipc_tx: &Sender<TuiMessage>) {
        match key.code {
            KeyCode::Up | KeyCode::BackTab if !self.suggestions.is_empty() => {
                self.popup_sel = self.popup_sel
                    .saturating_add(self.suggestions.len() - 1)
                    % self.suggestions.len();
                if let Some(cmd) = self.suggestions.get(self.popup_sel) {
                    self.input.set(cmd);
                }
            }
            KeyCode::Down | KeyCode::Tab if !self.suggestions.is_empty() => {
                self.popup_sel = (self.popup_sel + 1) % self.suggestions.len();
                if let Some(cmd) = self.suggestions.get(self.popup_sel) {
                    self.input.set(cmd);
                }
            }
            KeyCode::Enter if !self.suggestions.is_empty() => {
                if let Some(cmd) = self.suggestions.get(self.popup_sel).cloned() {
                    self.show_popup = false;
                    self.suggestions.clear();
                    self.input.set(&cmd);
                    // Submit immediately
                    self.history.push(HistoryEntry::plain(Role::User, cmd.clone()));
                    self.input.clear();
                    self.running = true;
                    self.status_msg = "Procesando...".to_string();
                    let _ = ipc_tx.try_send(TuiMessage::Submit { input: cmd });
                }
            }
            KeyCode::Esc | KeyCode::Char('c')
                if key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                self.show_popup = false;
                self.suggestions.clear();
                self.popup_sel = 0;
            }
            _ => {
                // Pass through to input
                let before = self.input.value();
                self.input.handle_key(key.code);
                let after = self.input.value();
                if before != after && after.starts_with('/') {
                    let _ = ipc_tx.try_send(TuiMessage::SuggestionsRequest {
                        query: after.clone(),
                    });
                } else if !after.starts_with('/') {
                    self.show_popup = false;
                    self.suggestions.clear();
                }
            }
        }
    }

    fn handle_copy_mode_key(&mut self, key: KeyEvent, _ipc_tx: &Sender<TuiMessage>) {
        match key.code {
            KeyCode::Up if !self.history.is_empty() => {
                self.copy_sel = self.copy_sel.saturating_sub(1);
            }
            KeyCode::Down if !self.history.is_empty() => {
                if self.copy_sel + 1 < self.history.len() {
                    self.copy_sel += 1;
                }
            }
            KeyCode::Enter if !self.history.is_empty() => {
                if let Some(entry) = self.history.get(self.copy_sel) {
                    let text = &entry.content;
                    let msg = match copy_to_clipboard(text) {
                        Ok(_)  => "✅ Entrada copiada al portapapeles".to_string(),
                        Err(e) => format!("⚠ Portapapeles: {}", e),
                    };
                    self.clipboard_feedback = Some((msg, std::time::Instant::now()));
                }
                self.copy_mode = false;
                self.status_msg = "Listo · [shift+tab] cambiar modo".to_string();
            }
            KeyCode::Esc | KeyCode::Char('c')
                if key.code == KeyCode::Esc || key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                self.copy_mode = false;
                self.status_msg = "Listo · [shift+tab] cambiar modo".to_string();
            }
            _ => {}
        }
    }

    fn handle_info_modal_key(&mut self, key: KeyEvent, ipc_tx: &Sender<TuiMessage>) {
        let max_scroll = self.info_modal_content.lines().count().saturating_sub(1);
        match key.code {
            KeyCode::Esc => {
                self.close_info_modal();
                let _ = ipc_tx.try_send(TuiMessage::InfoModalClose);
                self.status_msg = "Listo · [shift+tab] cambiar modo".to_string();
            }
            KeyCode::Up => {
                if self.info_scroll_offset > 0 {
                    self.info_scroll_offset -= 1;
                }
            }
            KeyCode::Down => {
                if self.info_scroll_offset < max_scroll {
                    self.info_scroll_offset += 1;
                }
            }
            _ => {}
        }
    }

    fn close_info_modal(&mut self) {
        self.show_info_modal = false;
        self.info_modal_title.clear();
        self.info_modal_content.clear();
        self.info_scroll_offset = 0;
    }

    fn handle_modal_key(&mut self, key: KeyEvent, ipc_tx: &Sender<TuiMessage>) {
        let n = self.modal_fields.len();
        if n == 0 { return; }

        match key.code {
            // Esc — cancel
            KeyCode::Esc => {
                let cmd = self.modal_command.clone();
                self.close_modal();
                let _ = ipc_tx.try_send(TuiMessage::ModalCancel { command: cmd });
                self.status_msg = "Listo · [shift+tab] cambiar modo".to_string();
            }
            // Ctrl+S — submit
            KeyCode::Char('s') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.try_submit_modal(ipc_tx);
            }
            // Enter — advance field or submit on last
            KeyCode::Enter => {
                let field = &self.modal_fields[self.modal_focused];
                // For select fields, cycle options on Enter too
                if field.field_type == "select" {
                    self.cycle_select_option(self.modal_focused);
                } else if self.modal_focused + 1 < n {
                    self.modal_focused += 1;
                } else {
                    self.try_submit_modal(ipc_tx);
                }
            }
            // Tab — next field (cycle)
            KeyCode::Tab => {
                self.modal_focused = (self.modal_focused + 1) % n;
            }
            // Shift+Tab — previous field (cycle)
            KeyCode::BackTab => {
                self.modal_focused = (self.modal_focused + n - 1) % n;
            }
            // Space on select field — cycle options
            KeyCode::Char(' ') if self.modal_fields[self.modal_focused].field_type == "select" => {
                self.cycle_select_option(self.modal_focused);
            }
            // Text editing for current field
            _ => {
                if self.modal_fields[self.modal_focused].field_type != "select" {
                    let cur = self.modal_cursors[self.modal_focused];
                    let chars: Vec<char> = self.modal_values[self.modal_focused].chars().collect();
                    let mut chars = chars;
                    let mut cursor = cur;
                    match key.code {
                        KeyCode::Char(c) => {
                            chars.insert(cursor, c);
                            cursor += 1;
                        }
                        KeyCode::Backspace if cursor > 0 => {
                            cursor -= 1;
                            chars.remove(cursor);
                        }
                        KeyCode::Delete if cursor < chars.len() => {
                            chars.remove(cursor);
                        }
                        KeyCode::Left if cursor > 0 => cursor -= 1,
                        KeyCode::Right if cursor < chars.len() => cursor += 1,
                        KeyCode::Home => cursor = 0,
                        KeyCode::End => cursor = chars.len(),
                        _ => {}
                    }
                    self.modal_values[self.modal_focused] = chars.iter().collect();
                    self.modal_cursors[self.modal_focused] = cursor;
                    // Clear error on edit
                    self.modal_errors[self.modal_focused] = false;
                }
            }
        }
    }

    fn cycle_select_option(&mut self, idx: usize) {
        let field = &self.modal_fields[idx];
        if let Some(opts) = &field.options {
            if opts.is_empty() { return; }
            let current = &self.modal_values[idx];
            let pos = opts.iter().position(|o| o == current).unwrap_or(0);
            let next = (pos + 1) % opts.len();
            self.modal_values[idx] = opts[next].clone();
        }
    }

    fn try_submit_modal(&mut self, ipc_tx: &Sender<TuiMessage>) {
        // Validate required fields
        let mut has_error = false;
        for (i, field) in self.modal_fields.iter().enumerate() {
            if field.required && self.modal_values[i].trim().is_empty() {
                self.modal_errors[i] = true;
                has_error = true;
            }
        }
        if has_error {
            self.status_msg = "Completa los campos obligatorios".to_string();
            return;
        }
        let cmd = self.modal_command.clone();
        let values: std::collections::HashMap<String, String> = self.modal_fields
            .iter()
            .enumerate()
            .map(|(i, f)| (f.key.clone(), self.modal_values[i].clone()))
            .collect();
        self.close_modal();
        self.running = true;
        self.status_msg = "Guardando...".to_string();
        let _ = ipc_tx.try_send(TuiMessage::ModalSubmit { command: cmd, values });
    }

    fn close_modal(&mut self) {
        self.show_modal = false;
        self.modal_fields.clear();
        self.modal_values.clear();
        self.modal_cursors.clear();
        self.modal_errors.clear();
        self.modal_title.clear();
        self.modal_command.clear();
        self.modal_focused = 0;
    }

    pub fn fmt_tokens(&self) -> String {
        let n = self.token_count;
        if n < 1_000 {
            n.to_string()
        } else if n < 1_000_000 {
            format!("{:.1}k", n as f64 / 1_000.0)
        } else {
            format!("{:.1}M", n as f64 / 1_000_000.0)
        }
    }
}

// ── Terminal setup / teardown ────────────────────────────────────────────────

fn encode_osc52(text: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    format!("\x1b]52;c;{}\x07", encoded)
}

fn set_clipboard_osc52(text: &str) {
    print!("{}", encode_osc52(text));
    let _ = std::io::stdout().flush();
}

fn copy_to_clipboard(text: &str) -> Result<(), String> {
    match arboard::Clipboard::new().and_then(|mut cb| cb.set_text(text.to_string())) {
        Ok(_) => Ok(()),
        Err(_) => {
            // Fallback to OSC 52 (works in modern terminals: kitty, wezterm,
            // alacritty, foot, iTerm2, Ghostty, tmux with passthrough)
            set_clipboard_osc52(text);
            Ok(())
        }
    }
}

fn setup_terminal(_clear: bool) -> Result<Terminal<CrosstermBackend<std::io::Stdout>>> {
    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(out))?;
    terminal.clear()?;
    Ok(terminal)
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>) {
    let _ = terminal.clear();
    let _ = execute!(terminal.backend_mut(), LeaveAlternateScreen);
    let _ = disable_raw_mode();
    let _ = terminal.show_cursor();
}

// ── Main run loop ────────────────────────────────────────────────────────────

pub async fn run(screen: &str) -> Result<()> {
    // Install panic hook so terminal is always restored
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        default_panic(info);
    }));

    let mut channels = ipc::connect().await?;
    let ipc_tx = channels.sender.clone();
    let mut state = AppState::default();
    let mut terminal = setup_terminal(true)?;
    // Wrapped in Option so we can drop it on Suspend (stops the crossterm
    // background stdin-polling thread, preventing races with Bun's raw-mode reads).
    let mut events: Option<EventStream> = Some(EventStream::new());

    // Send ready signal
    let _ = ipc_tx.try_send(TuiMessage::Ready);

    // Ticker for cursor blink and mascot animation (500ms cadence).
    // Also guarantees a redraw after Bun messages arrive without a key event.
    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(500));

    loop {
        // ── Batch drain: apply all pending Bun messages before drawing ────────
        // Priority order: critical → normal → low.
        // During agent execution Bun sends many rapid messages (log entries,
        // narrative chunks, activity updates). Without draining, the loop would
        // redraw once per message — dozens of times per second — causing cursor
        // lag and wasted CPU. Draining batches them so we draw once per group.
        let mut suspended = false;
        'drain: loop {
            // 1. Drain critical first
            while let Ok(msg) = channels.critical.try_recv() {
                match msg {
                    BunMessage::Suspend => { suspended = true; break 'drain; }
                    BunMessage::Resume  => {
                        if events.is_none() {
                            terminal = setup_terminal(true)?;
                            events = Some(EventStream::new());
                        }
                    }
                    m => state.apply_message(m),
                }
            }
            // 2. Drain normal
            while let Ok(msg) = channels.normal.try_recv() {
                match msg {
                    BunMessage::Suspend => { suspended = true; break 'drain; }
                    BunMessage::Resume  => {
                        if events.is_none() {
                            terminal = setup_terminal(true)?;
                            events = Some(EventStream::new());
                        }
                    }
                    m => state.apply_message(m),
                }
            }
            // 3. Drain low
            while let Ok(msg) = channels.low.try_recv() {
                match msg {
                    BunMessage::Suspend => { suspended = true; break 'drain; }
                    BunMessage::Resume  => {}
                    m => state.apply_message(m),
                }
            }
            break;
        }
        if suspended {
            restore_terminal(&mut terminal);
            events = None;
            let _ = ipc_tx.try_send(TuiMessage::Suspended);
        }

        if events.is_some() && !state.paused {
            terminal.draw(|frame| {
                match screen {
                    "providers" => screens::providers::draw(frame, &state),
                    _           => screens::repl::draw(frame, &mut state),
                }
            })?;
        }

        if state.should_quit {
            break;
        }

        if events.is_none() {
            // Suspended — only wait for Resume (or other IPC); biased: critical first
            tokio::select! {
                biased;
                msg = channels.critical.recv() => match msg {
                    Some(BunMessage::Resume) => {
                        terminal = setup_terminal(true)?;
                        events = Some(EventStream::new());
                    }
                    Some(BunMessage::Suspend) => {}
                    Some(m) => state.apply_message(m),
                    None => break,
                },
                msg = channels.normal.recv() => match msg {
                    Some(BunMessage::Resume) => {
                        terminal = setup_terminal(true)?;
                        events = Some(EventStream::new());
                    }
                    Some(m) => state.apply_message(m),
                    None => break,
                },
                msg = channels.low.recv() => {
                    if let Some(m) = msg { state.apply_message(m); } else { break; }
                },
            }
            continue;
        }

        // Normal operation — biased select! drains critical before normal before low
        tokio::select! {
            biased;

            // Critical priority — conflict alerts, risk updates, init
            msg = channels.critical.recv() => {
                match msg {
                    Some(BunMessage::Suspend) => {
                        restore_terminal(&mut terminal);
                        events = None;
                        let _ = ipc_tx.try_send(TuiMessage::Suspended);
                    }
                    Some(BunMessage::Resume) => {}
                    Some(m) => state.apply_message(m),
                    None => {}
                }
            }

            maybe_event = events.as_mut().unwrap().next() => {
                match maybe_event {
                    // Ignore Release events — some terminals (kitty, WezTerm) send both
                    // Press and Release, which would double-process every key.
                    Some(Ok(Event::Key(key))) if key.kind != KeyEventKind::Release => {
                        state.handle_key(key, &ipc_tx);
                    }
                    Some(Ok(Event::Mouse(_mouse))) => {
                        // Mouse disabled — not supported in all terminals
                    }
                    Some(Err(_)) | None => break,
                    _ => {}
                }
            }

            msg = channels.normal.recv() => {
                match msg {
                    Some(BunMessage::Suspend) => {
                        restore_terminal(&mut terminal);
                        events = None;
                        let _ = ipc_tx.try_send(TuiMessage::Suspended);
                    }
                    Some(BunMessage::Resume) => {}
                    Some(m) => state.apply_message(m),
                    None => {}
                }
            }

            msg = channels.low.recv() => {
                if let Some(m) = msg { state.apply_message(m); }
            }

            _ = ticker.tick() => {
                state.cursor_visible = !state.cursor_visible;
                state.animation_frame = state.animation_frame.wrapping_add(1);
            }
        }

        // Handle pause mode (Ctrl+M) — disable raw mode so the terminal handles mouse
        // selection natively; we stay in alternate screen (content remains visible).
        if state.paused {
            let _ = events.take(); // drop EventStream so stdin is free
            let _ = disable_raw_mode();
            let _ = terminal.show_cursor();
            // Wait for Enter in blocking mode
            let _ = tokio::task::spawn_blocking(|| {
                let mut buf = String::new();
                let _ = std::io::stdin().read_line(&mut buf);
            }).await;
            // Re-enable raw mode — stay in alternate screen (no need to re-enter it)
            let _ = enable_raw_mode();
            let _ = terminal.clear();
            events = Some(EventStream::new());
            state.paused = false;
            state.status_msg = "Listo · [shift+tab] cambiar modo".to_string();
        }
    }

    restore_terminal(&mut terminal);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    #[test]
    fn test_encode_osc52() {
        assert_eq!(encode_osc52("hello"), "\x1b]52;c;aGVsbG8=\x07");
        assert_eq!(encode_osc52(""), "\x1b]52;c;\x07");
        assert_eq!(
            encode_osc52("Rust TUI \n🦀"),
            "\x1b]52;c;UnVzdCBUVUkgCvCfpoA=\x07"
        );
    }

    #[test]
    fn test_copy_mode_toggle_with_ctrl_k() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (tx, _rx) = tokio::sync::mpsc::channel::<TuiMessage>(10);
            let mut state = AppState::default();
            state.history.push(HistoryEntry::plain(Role::User, "hola".into()));
            state.history.push(HistoryEntry::plain(Role::Assistant, "adios".into()));

            let key = KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL);
            state.handle_key(key, &tx);

            assert!(state.copy_mode);
            assert_eq!(state.copy_sel, 1); // last index
        });
    }

    #[test]
    fn test_copy_mode_navigation() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (tx, _rx) = tokio::sync::mpsc::channel::<TuiMessage>(10);
            let mut state = AppState::default();
            state.history.push(HistoryEntry::plain(Role::User, "first".into()));
            state.history.push(HistoryEntry::plain(Role::Assistant, "second".into()));
            state.copy_mode = true;
            state.copy_sel = 1;

            // Up
            state.handle_copy_mode_key(
                KeyEvent::new(KeyCode::Up, KeyModifiers::empty()),
                &tx,
            );
            assert_eq!(state.copy_sel, 0);

            // Up again (should saturate at 0)
            state.handle_copy_mode_key(
                KeyEvent::new(KeyCode::Up, KeyModifiers::empty()),
                &tx,
            );
            assert_eq!(state.copy_sel, 0);

            // Down
            state.handle_copy_mode_key(
                KeyEvent::new(KeyCode::Down, KeyModifiers::empty()),
                &tx,
            );
            assert_eq!(state.copy_sel, 1);

            // Down again (should stay at last index)
            state.handle_copy_mode_key(
                KeyEvent::new(KeyCode::Down, KeyModifiers::empty()),
                &tx,
            );
            assert_eq!(state.copy_sel, 1);
        });
    }

    #[test]
    fn test_copy_mode_exit_with_esc() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (tx, _rx) = tokio::sync::mpsc::channel::<TuiMessage>(10);
            let mut state = AppState::default();
            state.copy_mode = true;
            state.copy_sel = 0;

            state.handle_copy_mode_key(
                KeyEvent::new(KeyCode::Esc, KeyModifiers::empty()),
                &tx,
            );

            assert!(!state.copy_mode);
        });
    }

    #[test]
    fn test_copy_mode_copy_and_exit_with_enter() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (tx, _rx) = tokio::sync::mpsc::channel::<TuiMessage>(10);
            let mut state = AppState::default();
            state.history.push(HistoryEntry::plain(Role::User, "copy me".into()));
            state.copy_mode = true;
            state.copy_sel = 0;

            state.handle_copy_mode_key(
                KeyEvent::new(KeyCode::Enter, KeyModifiers::empty()),
                &tx,
            );

            assert!(!state.copy_mode);
            assert!(state.clipboard_feedback.is_some());
        });
    }

    #[test]
    fn test_ctrl_c_in_normal_mode_exits() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (tx, _rx) = tokio::sync::mpsc::channel::<TuiMessage>(10);
            let mut state = AppState::default();

            let key = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
            state.handle_key(key, &tx);

            assert!(state.should_quit);
        });
    }
}
