/// Tab activo en el layout principal.
///
/// El orden de `ALL` **es** el orden de los atajos 1-6: `from_num` deriva del
/// índice, así que la lista del tabbar y la numeración no pueden desincronizarse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TabId {
    /// El enjambre en vivo: quién es, qué tool llama, qué espera.
    #[default]
    Swarm,
    /// El plan, con sus fases y de quién depende cada una.
    Plan,
    /// El campo: chat, narración y razonamiento.
    Mesa,
    /// Diffs, archivos y checkpoints.
    Code,
    /// Veredictos, conflictos y seguridad.
    Review,
    /// Configuración: agentes, skills, herramientas, MCP, logs.
    Taller,
}

/// La lista canónica de vistas. El tabbar la consume; `from_num` deriva de aquí.
pub const ALL_TABS: [TabId; 6] = [
    TabId::Swarm,
    TabId::Plan,
    TabId::Mesa,
    TabId::Code,
    TabId::Review,
    TabId::Taller,
];

impl TabId {
    pub fn from_num(n: u8) -> Option<Self> {
        if n == 0 {
            return None;
        }
        ALL_TABS.get((n - 1) as usize).copied()
    }

    pub fn from_name(s: &str) -> Option<Self> {
        let lower = s.to_lowercase();
        ALL_TABS.iter().copied().find(|t| t.slug() == lower)
    }

    /// Identificador estable para `/layout` y para IPC. No cambia aunque la
    /// etiqueta se traduzca.
    pub fn slug(&self) -> &'static str {
        match self {
            TabId::Swarm => "enjambre",
            TabId::Plan => "plan",
            TabId::Mesa => "mesa",
            TabId::Code => "codigo",
            TabId::Review => "revision",
            TabId::Taller => "taller",
        }
    }

    /// Etiqueta del tabbar. En español: el proyecto es 100 % en español.
    pub fn label(&self) -> &'static str {
        match self {
            TabId::Swarm => "ENJAMBRE",
            TabId::Plan => "PLAN",
            TabId::Mesa => "MESA",
            TabId::Code => "CÓDIGO",
            TabId::Review => "REVISIÓN",
            TabId::Taller => "TALLER",
        }
    }

    pub fn num(&self) -> u8 {
        ALL_TABS
            .iter()
            .position(|t| t == self)
            .map(|i| (i + 1) as u8)
            .unwrap_or(1)
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReplMode {
    Plan,
    Approval,
    #[default]
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
            mode: ReplMode::Auto,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shortcut_numbers_follow_the_canonical_order() {
        // `TABS` en el tabbar y `ALL_TABS` aquí no pueden divergir: si lo
        // hicieran, la tecla 3 abriría una vista distinta a la que dice el
        // tabbar.
        for (i, tab) in ALL_TABS.iter().enumerate() {
            assert_eq!(tab.num(), (i + 1) as u8, "{tab:?} deberia ser {}", i + 1);
            assert_eq!(TabId::from_num((i + 1) as u8), Some(*tab));
        }
    }

    #[test]
    fn from_num_rejects_zero_and_out_of_range() {
        assert_eq!(TabId::from_num(0), None);
        assert_eq!(TabId::from_num(7), None);
        assert_eq!(TabId::from_num(255), None);
    }

    #[test]
    fn the_spanish_slugs_round_trip() {
        // `/layout mesa` y `/layout MESA` tienen que abrir lo mismo.
        for tab in ALL_TABS {
            assert_eq!(TabId::from_name(tab.slug()), Some(tab));
            assert_eq!(TabId::from_name(&tab.slug().to_uppercase()), Some(tab));
        }
        assert_eq!(TabId::from_name("dashboard"), None, "el nombre viejo no debe revivir");
        assert_eq!(TabId::from_name("focus"), None);
    }

    #[test]
    fn every_label_is_uppercase_and_free_of_english_view_names() {
        // El tabbar es lo primero que ve el usuario: si aparece una etiqueta en
        // ingles, el proyecto deja de ser 100 % español.
        let english = ["FOCUS", "CODE", "REVIEW", "DASHBOARD", "WORKERS", "SETTINGS"];
        for tab in ALL_TABS {
            let label = tab.label();
            assert!(!label.chars().any(|c| c.is_lowercase()), "{label} no esta en mayusculas");
            for word in english {
                assert_ne!(label, word, "la etiqueta {label} sigue en ingles");
            }
        }
        // Los acentos se conservan: "CÓDIGO" y "REVISIÓN" no son "CODIGO".
        assert_eq!(TabId::Code.label(), "CÓDIGO");
        assert_eq!(TabId::Review.label(), "REVISIÓN");
    }

    #[test]
    fn the_labels_fit_in_a_single_tab_slot() {
        // "CODIGO" y "REVISION" llevan acento: el ancho se cuenta en celdas, y
        // una etiqueta mas ancha que su slot parte el tabbar.
        for tab in ALL_TABS {
            let label = tab.label();
            assert!(crate::ui::text::cell_width(label) <= 8, "{label} es muy ancho");
        }
    }

    #[test]
    fn swarm_is_the_landing_view() {
        // La vista que responde "¿que esta pasando ahora?" debe ser la primera.
        assert_eq!(TabId::default(), TabId::Swarm);
        assert_eq!(TabId::default().num(), 1);
    }
}
