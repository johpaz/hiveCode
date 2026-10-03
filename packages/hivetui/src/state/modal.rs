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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewAction {
    Approve,
    Reject,
    Modify,
}

impl ReviewAction {
    pub fn label(self) -> &'static str {
        match self {
            ReviewAction::Approve => "aprobar",
            ReviewAction::Reject => "rechazar",
            ReviewAction::Modify => "pedir modificación",
        }
    }

    pub fn command(self) -> &'static str {
        match self {
            ReviewAction::Approve => "/approve",
            ReviewAction::Reject => "/reject necesita ajustes",
            ReviewAction::Modify => "/reject pedir modificación",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ReviewConfirmState {
    pub action: ReviewAction,
}

// ── Settings Hub ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SettingsTab {
    #[default]
    Providers,
    Models,
    Agents,
    Mcp,
    Skills,
    Github,
    Telegram,
}

impl SettingsTab {
    pub const ALL: &'static [SettingsTab] = &[
        SettingsTab::Providers,
        SettingsTab::Models,
        SettingsTab::Agents,
        SettingsTab::Mcp,
        SettingsTab::Skills,
        SettingsTab::Github,
        SettingsTab::Telegram,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Providers => "Providers",
            Self::Models    => "Modelos",
            Self::Agents    => "Agentes",
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
    /// Modelos llm habilitados del provider (los envía Bun ya filtrados).
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SettingsMcp {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    pub has_headers: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SettingsAgent {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub max_turns: u32,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
    pub max_cost_usd: f64,
    pub permission_profile: String,
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
    pub scroll_offset: usize,
    pub providers: Vec<SettingsProvider>,
    pub agents: Vec<SettingsAgent>,
    pub mcp: Vec<SettingsMcp>,
    pub skills: Vec<SettingsSkill>,
    pub github_connected: bool,
    pub github_repo: Option<String>,
    pub telegram_active: bool,
    /// true mientras esperamos que Bun responda con SettingsData
    pub loading: bool,
}

/// Filas del tab Modelos.
///
/// Con provider activo solo se listan sus modelos: mezclar los ~115 modelos de
/// todos los providers en un mismo select hacía inmanejable cambiar de modelo.
/// Sin provider activo no hay modelos que ofrecer, así que el tab muestra los
/// providers y hay que elegir uno primero.
pub enum ModelRows<'a> {
    NeedProvider { providers: &'a [SettingsProvider] },
    Models { provider_id: &'a str, models: &'a [String] },
}

impl SettingsHubState {
    /// Provider marcado como default, si lo hay.
    pub fn active_provider(&self) -> Option<&SettingsProvider> {
        self.providers.iter().find(|p| p.is_active)
    }

    pub fn model_rows(&self) -> ModelRows<'_> {
        match self.active_provider() {
            Some(p) if !p.models.is_empty() => ModelRows::Models {
                provider_id: &p.id,
                models: &p.models,
            },
            // Provider activo sin modelos (o sin provider): elegir provider primero.
            _ => ModelRows::NeedProvider { providers: &self.providers },
        }
    }

    /// Cuántas filas navega el tab Modelos.
    pub fn model_row_count(&self) -> usize {
        match self.model_rows() {
            ModelRows::NeedProvider { providers } => providers.len(),
            ModelRows::Models { models, .. } => models.len(),
        }
    }
}

// ── ModalState ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub enum ModalState {
    #[default]
    None,
    Config(ConfigModalState),
    Info(InfoModalState),
    PlanApproval(PlanApprovalState),
    ReviewConfirm(ReviewConfirmState),
    Settings(SettingsHubState),
}
