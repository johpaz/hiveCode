/// Session-level mode and mascot state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplMode {
    Plan,
    Approval,
    Auto,
}

impl ReplMode {
    pub fn label(&self) -> &'static str {
        match self {
            ReplMode::Plan     => "PLAN",
            ReplMode::Approval => "APROBACIÓN",
            ReplMode::Auto     => "AUTO",
        }
    }

    pub fn next(&self) -> ReplMode {
        match self {
            ReplMode::Plan     => ReplMode::Approval,
            ReplMode::Approval => ReplMode::Auto,
            ReplMode::Auto     => ReplMode::Plan,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ReplMode::Plan     => "plan",
            ReplMode::Approval => "approval",
            ReplMode::Auto     => "auto",
        }
    }
}

impl From<&str> for ReplMode {
    fn from(s: &str) -> Self {
        match s {
            "approval" => ReplMode::Approval,
            "auto"     => ReplMode::Auto,
            _          => ReplMode::Plan,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MascotState {
    Welcome,
    Thinking,
    Searching,
    Reading,
    Writing,
    Executing,
    Completed,
    Error,
    Idle,
    PlanMode,
    Approval,
}

/// Session-level metadata sent from Bun on Init.
#[derive(Debug, Clone)]
pub struct SessionState {
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
    pub mascot: MascotState,
}

impl Default for SessionState {
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
            mascot: MascotState::Welcome,
        }
    }
}

impl SessionState {
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
