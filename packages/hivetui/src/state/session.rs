#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReplMode {
    #[default]
    Plan,
    Approval,
    Auto,
}

impl ReplMode {
    pub fn label(&self) -> &'static str {
        match self {
            ReplMode::Plan => "PLAN",
            ReplMode::Approval => "APROBACION",
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
    fn from(value: &str) -> Self {
        match value {
            "approval" => ReplMode::Approval,
            "auto" => ReplMode::Auto,
            _ => ReplMode::Plan,
        }
    }
}

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
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            mode: ReplMode::Plan,
            provider: String::new(),
            model: String::new(),
            project_name: "hivetui".to_string(),
            project_path: std::env::current_dir()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
            session_id: String::new(),
            version: "0.1.0".to_string(),
            task_count: 0,
            token_count: 0,
            workers: Vec::new(),
        }
    }
}
