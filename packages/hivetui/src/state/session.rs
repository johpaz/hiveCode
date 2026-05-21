/// Tab activo en el layout principal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TabId {
    #[default]
    Focus,
    Plan,
    Code,
    Review,
    Dashboard,
}

impl TabId {
    pub fn from_num(n: u8) -> Option<Self> {
        match n {
            1 => Some(TabId::Focus),
            2 => Some(TabId::Plan),
            3 => Some(TabId::Code),
            4 => Some(TabId::Review),
            5 => Some(TabId::Dashboard),
            _ => None,
        }
    }
    pub fn from_name(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "focus"     => Some(TabId::Focus),
            "plan"      => Some(TabId::Plan),
            "code"      => Some(TabId::Code),
            "review"    => Some(TabId::Review),
            "dashboard" => Some(TabId::Dashboard),
            _ => None,
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            TabId::Focus     => "FOCUS",
            TabId::Plan      => "PLAN",
            TabId::Code      => "CODE",
            TabId::Review    => "REVIEW",
            TabId::Dashboard => "DASHBOARD",
        }
    }
    pub fn num(&self) -> u8 {
        match self {
            TabId::Focus     => 1,
            TabId::Plan      => 2,
            TabId::Code      => 3,
            TabId::Review    => 4,
            TabId::Dashboard => 5,
        }
    }
}

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
