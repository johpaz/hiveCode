use color_eyre::eyre::Result;
use crossterm::{
    event::{
        Event, EventStream, KeyCode, KeyEvent,
        KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::StreamExt;
use ratatui::{backend::CrosstermBackend, layout::Rect, Terminal};
use std::io::stdout;
use tokio::sync::mpsc::Sender;
use tokio::time::{interval, Duration};

use crate::ipc::{self, BunMessage, MenuItem, TuiMessage};
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
}

#[derive(Debug, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct Phase {
    pub name: String,
    pub coordinator: String,
    pub status: String,
    pub duration_ms: Option<u64>,
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
    pub agent_count: u32,
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
            agent_count: 0,
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
                version, task_count, token_count, agent_count,
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
                self.agent_count = agent_count;
            }
            BunMessage::HistoryAppend { role, content } => {
                self.history.push(HistoryEntry {
                    role: Role::from(role.as_str()),
                    content,
                });
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
                self.history.push(HistoryEntry {
                    role: Role::Shell,
                    content,
                });
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
            BunMessage::NarrativeChunk { coordinator, phase, content } => {
                self.narrative_chunks.push((coordinator.clone(), phase.clone(), content.clone()));
                if self.narrative_chunks.len() > 100 {
                    self.narrative_chunks.remove(0);
                }
                // Render narrative chunks in the chat history so user sees agent activity
                if !content.is_empty() {
                    let role = if phase == "thinking" {
                        self.mascot_state = MascotState::Thinking;
                        Role::Thinking
                    } else {
                        Role::Assistant
                    };
                    self.history.push(HistoryEntry {
                        role,
                        content: format!("[{}] {}", coordinator, content),
                    });
                }
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
                    self.history.push(HistoryEntry {
                        role: if self.shell_mode { Role::Shell } else { Role::User },
                        content: input.clone(),
                    });
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
            _ if !self.running => {
                let before = self.input.value();
                self.input.handle_key(key.code);
                let after = self.input.value();

                if before != after {
                    // Request suggestions if input starts with /
                    if after.starts_with('/') {
                        let _ = ipc_tx.try_send(TuiMessage::SuggestionsRequest {
                            query: after.clone(),
                        });
                    } else {
                        self.show_popup = false;
                        self.suggestions.clear();
                    }
                }
            }
            _ => {}
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
                    self.history.push(HistoryEntry {
                        role: Role::User,
                        content: cmd.clone(),
                    });
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

fn setup_terminal() -> Result<Terminal<CrosstermBackend<std::io::Stdout>>> {
    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(out);
    Ok(Terminal::new(backend)?)
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>) {
    let _ = disable_raw_mode();
    let _ = execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
    );
    let _ = terminal.show_cursor();
}

// ── Main run loop ────────────────────────────────────────────────────────────

pub async fn run(screen: &str) -> Result<()> {
    // Install panic hook so terminal is always restored
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(
            stdout(),
            LeaveAlternateScreen,
        );
        default_panic(info);
    }));

    let (mut bun_rx, ipc_tx) = ipc::connect().await?;
    let mut state = AppState::default();
    let mut terminal = setup_terminal()?;
    // Wrapped in Option so we can drop it on Suspend (stops the crossterm
    // background stdin-polling thread, preventing races with Bun's raw-mode reads).
    let mut events: Option<EventStream> = Some(EventStream::new());

    // Send ready signal
    let _ = ipc_tx.try_send(TuiMessage::Ready);

    loop {
        if events.is_some() {
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
            // Suspended — only wait for Resume (or other IPC)
            match bun_rx.recv().await {
                Some(BunMessage::Resume) => {
                    terminal = setup_terminal()?;
                    events = Some(EventStream::new());
                }
                Some(BunMessage::Suspend) => {} // already suspended, ignore
                Some(msg) => state.apply_message(msg),
                None => break,
            }
            continue;
        }

        // Normal operation — events is Some
        let mut ticker = interval(Duration::from_millis(1200));
        
        tokio::select! {
            biased;

            _ = ticker.tick() => {
                state.cursor_visible = !state.cursor_visible;
                state.animation_frame = state.animation_frame.wrapping_add(1);
            }

            maybe_event = events.as_mut().unwrap().next() => {
                match maybe_event {
                    Some(Ok(Event::Key(key))) => {
                        state.handle_key(key, &ipc_tx);
                    }
                    Some(Ok(Event::Mouse(_mouse))) => {
                        // Mouse disabled — Antigravity terminal doesn't support it well
                    }
                    Some(Err(_)) | None => break,
                    _ => {}
                }
            }

            maybe_msg = bun_rx.recv() => {
                match maybe_msg {
                    Some(BunMessage::Suspend) => {
                        restore_terminal(&mut terminal);
                        events = None; // drop EventStream → kills background stdin thread
                        let _ = ipc_tx.try_send(TuiMessage::Suspended);
                    }
                    Some(BunMessage::Resume) => {} // not suspended, ignore
                    Some(msg) => state.apply_message(msg),
                    None => {}
                }
            }
        }
    }

    restore_terminal(&mut terminal);
    Ok(())
}
