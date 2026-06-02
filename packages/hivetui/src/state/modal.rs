#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ModalFieldKind {
    #[default]
    Text,
    Secret,
    Select,
}

#[derive(Debug, Clone, Default)]
pub struct ModalField {
    pub key: String,
    pub label: String,
    pub kind: ModalFieldKind,
    pub required: bool,
    pub default_value: Option<String>,
    pub options: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigModalState {
    pub command: String,
    pub title: String,
    pub fields: Vec<ModalField>,
    pub values: Vec<String>,
    pub cursors: Vec<usize>,
    pub focused: usize,
    pub errors: Vec<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct InfoModalState {
    pub title: String,
    pub content: String,
    pub scroll: usize,
}

#[derive(Debug, Clone, Default)]
pub struct PlanApprovalState {
    pub selected: usize,  // 0=auto, 1=approval, 2=suggest, 3=cancel
}

// ── Settings Hub ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SettingsTab {
    #[default]
    Providers,
    Models,
    Mcp,
    Skills,
    Github,
    Telegram,
}

impl SettingsTab {
    pub const ALL: &'static [SettingsTab] = &[
        SettingsTab::Providers,
        SettingsTab::Models,
        SettingsTab::Mcp,
        SettingsTab::Skills,
        SettingsTab::Github,
        SettingsTab::Telegram,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Providers => "Providers",
            Self::Models    => "Modelos",
            Self::Mcp       => "MCP",
            Self::Skills    => "Skills",
            Self::Github    => "GitHub",
            Self::Telegram  => "Telegram",
        }
    }

    pub fn next(self) -> Self {
        let idx = Self::ALL.iter().position(|t| *t == self).unwrap_or(0);
        Self::ALL[(idx + 1) % Self::ALL.len()]
    }

    pub fn prev(self) -> Self {
        let idx = Self::ALL.iter().position(|t| *t == self).unwrap_or(0);
        Self::ALL[(idx + Self::ALL.len() - 1) % Self::ALL.len()]
    }
}

#[derive(Debug, Clone, Default)]
pub struct SettingsProvider {
    pub id: String,
    pub name: String,
    pub model: String,
    pub is_active: bool,
    pub has_key: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SettingsMcp {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SettingsSkill {
    pub name: String,
    pub description: String,
    pub category: String,
    pub active: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SettingsHubState {
    pub active_tab: SettingsTab,
    pub selected_row: usize,
    pub providers: Vec<SettingsProvider>,
    pub mcp: Vec<SettingsMcp>,
    pub skills: Vec<SettingsSkill>,
    pub github_connected: bool,
    pub github_repo: Option<String>,
    pub telegram_active: bool,
    /// true mientras esperamos que Bun responda con SettingsData
    pub loading: bool,
}

// ── ModalState ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub enum ModalState {
    #[default]
    None,
    Config(ConfigModalState),
    Info(InfoModalState),
    PlanApproval(PlanApprovalState),
    Settings(SettingsHubState),
}
