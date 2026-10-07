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

/// Acción que un modal de config ejecuta al confirmarse.
///
/// Los modales que llegan de Bun no la llevan: su `command` identifica el
/// handler de `tui-launcher.ts` y se responde con `ModalSubmit`. Los que
/// **nace en la TUI** (p. ej. pedir la API key de un provider ya elegido) la
/// llevan, y `handle_config_modal_key` emite el mensaje que corresponda en vez
/// de `ModalSubmit` — que en Bun no resolvería nada porque no hay modal parked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModalAction {
    /// Activar el provider `provider_id` con la API key escrita en el campo
    /// `api_key`. Se envía tal cual: **no** se vuelve a listar la lista de
    /// providers, que es lo que hacía el flujo anterior.
    ProviderActivate { provider_id: String },
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
    /// `Some` cuando el modal lo abrió la TUI y no Bun.
    pub action: Option<ModalAction>,
    /// Hub de settings al que volver al cerrar este modal, con su estado actual.
    /// Sin esto, cerrar el modal de la API key dejaba al hub cerrado y el
    /// `SettingsData` de respuesta se descartaba (`SettingsData` solo se aplica
    /// si el hub está montado), obligando a pulsar F2 otra vez.
    pub return_to: Option<SettingsHubState>,
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
    /// ¿Hay API key en el keystore? Lo responde Bun (`hasProviderApiKey`).
    pub has_key: bool,
    /// El provider se autentica con login de navegador (PKCE), no con API key
    /// — p. ej. `hivecode-free`. Pedirle una clave sería un callejón sin salida.
    pub browser_login: bool,
    /// Modelos llm habilitados del provider (los envía Bun ya filtrados).
    pub models: Vec<String>,
}

impl SettingsProvider {
    /// ¿El usuario tiene que escribir una API key para poder usar este provider?
    pub fn needs_key(&self) -> bool {
        !self.has_key && !self.browser_login
    }

    /// Estado de credenciales tal como se muestra en la columna `Key`.
    pub fn key_state(&self) -> ProviderKeyState {
        if self.has_key {
            ProviderKeyState::Ready
        } else if self.browser_login {
            ProviderKeyState::BrowserLogin
        } else {
            ProviderKeyState::Missing
        }
    }
}

/// Cómo está autenticado un provider. Cada variante tiene su glifo en la
/// columna `Key` del hub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKeyState {
    /// Clave en el keystore.
    Ready,
    /// Sin clave: hay que escribirla.
    Missing,
    /// Login de navegador, no usa API key.
    BrowserLogin,
}

impl ProviderKeyState {
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Ready       => "✓",
            Self::Missing     => "?",
            Self::BrowserLogin => "~",
        }
    }

    /// Explicación para el footer del hub.
    pub fn hint(self) -> &'static str {
        match self {
            Self::Ready       => "clave guardada",
            Self::Missing     => "falta API key",
            Self::BrowserLogin => "login de navegador",
        }
    }
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

    /// Provider de la fila `index`, si existe.
    pub fn provider_at(&self, index: usize) -> Option<&SettingsProvider> {
        self.providers.get(index)
    }

    /// Cuántos providers requieren que el usuario escriba una API key.
    /// El footer lo usa para señalar que `Enter` abrirá el formulario de clave.
    pub fn missing_key_count(&self) -> usize {
        self.providers.iter().filter(|p| p.needs_key()).count()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, is_active: bool, models: &[&str]) -> SettingsProvider {
        SettingsProvider {
            id: id.to_string(),
            name: id.to_string(),
            model: models.first().map(|m| m.to_string()).unwrap_or_default(),
            is_active,
            has_key: true,
            browser_login: false,
            models: models.iter().map(|m| m.to_string()).collect(),
        }
    }

    #[test]
    fn con_provider_activo_solo_sale_sus_modelos() {
        let mut hub = SettingsHubState::default();
        hub.providers = vec![
            provider("nvidia", false, &["nvidia/kimi-k3", "nvidia/gemma-4-31b-it"]),
            provider("hiveagents", true, &["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"]),
        ];

        match hub.model_rows() {
            ModelRows::Models { provider_id, models } => {
                assert_eq!(provider_id, "hiveagents");
                // Ningún modelo de otro provider se cuela en la lista.
                assert_eq!(models, &["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf".to_string()]);
            }
            ModelRows::NeedProvider { .. } => panic!("debía listar los modelos del provider activo"),
        }
        assert_eq!(hub.model_row_count(), 1);
    }

    #[test]
    fn sin_provider_activo_hay_que_elegir_provider_primero() {
        let mut hub = SettingsHubState::default();
        hub.providers = vec![
            provider("anthropic", false, &["claude-opus-4-6"]),
            provider("openai", false, &["gpt-5.4"]),
        ];

        assert!(matches!(hub.model_rows(), ModelRows::NeedProvider { .. }));
        // Las filas son providers, no modelos.
        assert_eq!(hub.model_row_count(), 2);
    }

    #[test]
    fn provider_activo_sin_modelos_tambien_pide_provider_primero() {
        let mut hub = SettingsHubState::default();
        hub.providers = vec![provider("vacio", true, &[])];

        assert!(matches!(hub.model_rows(), ModelRows::NeedProvider { .. }));
        assert_eq!(hub.model_row_count(), 1);
    }

    #[test]
    fn sin_ningun_provider_el_tab_no_rompe() {
        let hub = SettingsHubState::default();
        assert!(matches!(hub.model_rows(), ModelRows::NeedProvider { providers } if providers.is_empty()));
        assert_eq!(hub.model_row_count(), 0);
    }

    #[test]
    fn provider_sin_clave_necesita_api_key() {
        let mut p = provider("openai", false, &["gpt-5.4"]);
        p.has_key = false;

        assert!(p.needs_key());
        assert_eq!(p.key_state(), ProviderKeyState::Missing);
    }

    #[test]
    fn provider_con_clave_no_pide_nada() {
        let p = provider("anthropic", false, &["claude-opus-4-6"]);

        assert!(!p.needs_key());
        assert_eq!(p.key_state(), ProviderKeyState::Ready);
    }

    #[test]
    fn provider_de_login_no_pide_api_key() {
        // hivecode-free se autentica con PKCE: exigirle una clave dejaría al
        // usuario en un formulario que no puede completar.
        let mut p = provider("hivecode-free", false, &["deepseek-v4-flash"]);
        p.has_key = false;
        p.browser_login = true;

        assert!(!p.needs_key());
        assert_eq!(p.key_state(), ProviderKeyState::BrowserLogin);
    }

    #[test]
    fn el_estado_de_clave_tiene_un_glifo_por_variante() {
        let glyphs = [
            ProviderKeyState::Ready,
            ProviderKeyState::Missing,
            ProviderKeyState::BrowserLogin,
        ]
        .map(|s| s.glyph());
        // Glyphs distintos: la columna Key no puede colapsar dos estados.
        assert_ne!(glyphs[0], glyphs[1]);
        assert_ne!(glyphs[1], glyphs[2]);
        assert_ne!(glyphs[0], glyphs[2]);
        for state in [ProviderKeyState::Ready, ProviderKeyState::Missing, ProviderKeyState::BrowserLogin] {
            assert!(!state.hint().is_empty());
        }
    }

    #[test]
    fn missing_key_count_solo_cuenta_los_que_necesitan_clave() {
        let mut hub = SettingsHubState::default();
        let mut sin_clave = provider("openai", false, &["gpt-5.4"]);
        sin_clave.has_key = false;
        let mut browser = provider("hivecode-free", false, &["deepseek-v4-flash"]);
        browser.has_key = false;
        browser.browser_login = true;

        hub.providers = vec![provider("anthropic", true, &["claude-opus-4-6"]), sin_clave, browser];

        assert_eq!(hub.missing_key_count(), 1);
    }

    #[test]
    fn provider_at_solo_devuelve_filas_existentes() {
        let mut hub = SettingsHubState::default();
        hub.providers = vec![provider("a", false, &[]), provider("b", false, &[])];

        assert_eq!(hub.provider_at(1).map(|p| p.id.as_str()), Some("b"));
        assert!(hub.provider_at(2).is_none());
    }
}
