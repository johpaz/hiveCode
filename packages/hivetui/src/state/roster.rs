//! El enjambre, visto de un vistazo.
//!
//! Llega como un snapshot completo en `init` y en cada alta o baja de agente,
//! **nunca** en el camino caliente. Es la serialización de
//! `describeSwarmCapabilities()` — la misma función sobre la que enruta Jev — a
//! propósito: un segundo roster leyendo un campo de capacidad distinto
//! divergiría, y la UI terminaría anunciando herramientas que el agente no
//! tiene.
//!
//! Cada especialista lleva dos nombres: el **rol interno** (`backend`), que es lo
//! que viaja por el bus, aparece en los logs y usa la bitmask de sesión; y el
//! **alias** (`Topo`), que es lo que el ojo lee. El rol nunca desaparece.

use std::collections::HashMap;

use crate::ipc::{IpcRosterAgent, IpcRosterMcpRef};
use crate::state::agent_graph::AgentTier;

/// Estado de un servidor MCP, y lo que significa para quien depende de él.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpState {
    /// Conectado y con herramientas.
    Active,
    /// Habilitado, se conecta al primer uso.
    Available,
    /// Deshabilitado: delegar aquí ahora sería handing it a alguien que no puede.
    Off,
    /// No declarado en el snapshot.
    Unknown,
}

impl McpState {
    pub fn from_str(raw: &str) -> Self {
        match raw {
            "activo" => McpState::Active,
            "disponible" => McpState::Available,
            "apagado" => McpState::Off,
            _ => McpState::Unknown,
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            McpState::Active => "●",
            McpState::Available => "○",
            McpState::Off => "×",
            McpState::Unknown => "·",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            McpState::Active => "conectado",
            McpState::Available => "disponible",
            McpState::Off => "apagado",
            McpState::Unknown => "desconocido",
        }
    }
}

/// Un especialista del enjambre.
#[derive(Debug, Clone)]
pub struct RosterAgent {
    pub id: String,
    /// Rol interno — sobrevive aunque el alias cambie.
    pub rol: String,
    /// Alias visible. Nunca vacío: si el backend no lo manda, se deriva del rol.
    pub alias: String,
    /// Una línea en español con qué hace.
    pub funcion: String,
    pub tier: AgentTier,
    pub tools: Vec<String>,
    pub mcp: Vec<(String, McpState)>,
}

impl RosterAgent {
    /// `Topo · Backend` — alias primero porque es lo que el ojo busca, rol
    /// después porque es lo que hace grep funcionar.
    pub fn label(&self) -> String {
        if self.rol.is_empty() || self.rol.eq_ignore_ascii_case(&self.alias) {
            self.alias.clone()
        } else {
            format!("{} · {}", self.alias, self.rol)
        }
    }

    /// ¿Tiene algún MCP apagado? Es la razón por la que `planJevContext` devuelve
    /// `agentMcpOff`: el especialista correcto, pero inoperable hasta que el
    /// usuario encienda eso.
    pub fn blocked_by(&self) -> Vec<&str> {
        self.mcp
            .iter()
            .filter(|(_, state)| *state == McpState::Off)
            .map(|(name, _)| name.as_str())
            .collect()
    }

    pub fn is_operable(&self) -> bool {
        self.blocked_by().is_empty()
    }

    /// Cuenta un tool si lo tiene. Lo usa `/habilidades` para no ofrecer una
    /// skill cuyas tools el agente no posee.
    pub fn has_tool(&self, tool: &str) -> bool {
        self.tools.iter().any(|t| t == tool)
    }

    pub fn color(&self) -> crate::term::Color {
        crate::ui::Theme::worker(&self.rol)
    }
}

/// Un servidor MCP del enjambre, con su estado global.
#[derive(Debug, Clone)]
pub struct McpRef {
    pub id: String,
    pub name: String,
    pub tools: u64,
    pub state: McpState,
}

/// Una habilidad, resumida para el TALLER.
///
/// No es el catálogo completo: al TALLER le basta nombre, categoría, descripción
/// corta y si está activa. El `body` de la skill son cientos de líneas de
/// markdown que no caben en ninguna columna.
#[derive(Debug, Clone, Default)]
pub struct SkillSummary {
    pub name: String,
    pub category: String,
    pub description: String,
    pub active: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RosterState {
    /// Por `id`, que es como llegan las tool calls (`agent` = id).
    pub by_id: HashMap<String, RosterAgent>,
    /// Por rol, para cuando un evento trae el rol y no el id.
    pub by_role: HashMap<String, String>,
    /// Estado global de cada servidor MCP. `apagado` aquí es lo que bloquea a
    /// cualquier especialista que lo declare en su `mcp`.
    pub mcp_servers: Vec<McpRef>,
}

impl RosterState {
    pub fn apply(&mut self, agents: Vec<IpcRosterAgent>) {
        self.by_id.clear();
        self.by_role.clear();
        for a in agents {
            let rol = a.rol.clone();
            let agent = RosterAgent {
                // Sin alias, el rol sigue siendo legible: no se muestra "·".
                alias: if a.alias.trim().is_empty() {
                    crate::state::agent_display_name(&a.rol)
                } else {
                    a.alias
                },
                id: a.id.clone(),
                rol: rol.clone(),
                funcion: a.funcion,
                tier: tier_from_level(a.nivel),
                tools: a.tools,
                mcp: a.mcp.iter().map(mcp_ref).collect(),
            };
            if !rol.is_empty() {
                self.by_role.insert(rol, a.id.clone());
            }
            self.by_id.insert(a.id, agent);
        }
    }

    /// Resuelve un nombre de agente a su ficha. Acepta el `id` (lo que mandan
    /// las tool calls) y cae al rol (lo que aparece en algunos eventos).
    pub fn resolve(&self, name: &str) -> Option<&RosterAgent> {
        if let Some(a) = self.by_id.get(name) {
            return Some(a);
        }
        self.by_role
            .get(&name.to_ascii_lowercase())
            .and_then(|id| self.by_id.get(id))
    }

    pub fn agents(&self) -> Vec<&RosterAgent> {
        let mut v: Vec<&RosterAgent> = self.by_id.values().collect();
        v.sort_by(|a, b| a.tier.cmp(&b.tier).then(a.rol.cmp(&b.rol)));
        v
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// Especialistas bloqueados por algún MCP apagado. La TUI los marca antes de
    /// que Jev tenga nada que decir.
    pub fn blocked(&self) -> Vec<&RosterAgent> {
        self.by_id.values().filter(|a| !a.is_operable()).collect()
    }
}

fn mcp_ref(r: &IpcRosterMcpRef) -> (String, McpState) {
    (r.name.clone(), McpState::from_str(&r.state))
}

/// El backend manda `nivel` como el mismo 0-5 que usa el grafo de la TUI.
fn tier_from_level(level: u8) -> AgentTier {
    match level {
        0 => AgentTier::Orchestrator,
        1 => AgentTier::Planning,
        2 => AgentTier::Engineering,
        3 => AgentTier::Quality,
        4 => AgentTier::Gate,
        _ => AgentTier::OnDemand,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ipc_agent(id: &str, rol: &str, alias: &str, nivel: u8) -> IpcRosterAgent {
        IpcRosterAgent {
            id: id.to_string(),
            rol: rol.to_string(),
            alias: alias.to_string(),
            funcion: "función de prueba".to_string(),
            nivel,
            tools: vec!["fs_read".to_string()],
            mcp: vec![],
        }
    }

    #[test]
    fn an_agent_is_readable_by_id_and_by_role() {
        // Las tool calls llegan con `id`; algunos eventos traen el rol. Ambos
        // tienen que resolver a la misma ficha.
        let mut roster = RosterState::default();
        roster.apply(vec![ipc_agent("agent-1", "backend", "Topo", 2)]);

        assert_eq!(roster.resolve("agent-1").map(|a| a.alias.as_str()), Some("Topo"));
        assert_eq!(roster.resolve("backend").map(|a| a.alias.as_str()), Some("Topo"));
        assert!(roster.resolve("frontend").is_none());
    }

    #[test]
    fn the_label_puts_the_alias_first_and_keeps_the_role() {
        // El rol nunca desaparece: sirve para grep y para los logs.
        let mut roster = RosterState::default();
        roster.apply(vec![ipc_agent("a", "backend", "Topo", 2)]);
        assert_eq!(roster.by_id["a"].label(), "Topo · backend");
    }

    #[test]
    fn a_missing_alias_falls_back_to_the_role_instead_of_showing_nothing() {
        let mut roster = RosterState::default();
        roster.apply(vec![ipc_agent("a", "backend", "  ", 2)]);
        let agent = &roster.by_id["a"];
        assert!(!agent.alias.is_empty());
        assert_eq!(agent.label(), "Topo · backend");
    }

    #[test]
    fn an_off_mcp_blocks_the_specialist() {
        // Esta es la razón por la que existe `agentMcpOff`: el especialista
        // correcto pero inoperable hasta que el usuario encienda eso.
        let mut a = ipc_agent("a", "quetzal", "Quetzal", 2);
        a.mcp = vec![
            IpcRosterMcpRef { name: "obscura".into(), state: "apagado".into() },
            IpcRosterMcpRef { name: "otro".into(), state: "activo".into() },
        ];
        let mut roster = RosterState::default();
        roster.apply(vec![a]);

        let agent = &roster.by_id["a"];
        assert_eq!(agent.blocked_by(), vec!["obscura"]);
        assert!(!agent.is_operable());
        assert_eq!(roster.blocked().len(), 1);
    }

    #[test]
    fn an_available_mcp_does_not_block() {
        // "disponible" se conecta al primer uso: no es un bloqueo.
        let mut a = ipc_agent("a", "quetzal", "Quetzal", 2);
        a.mcp = vec![IpcRosterMcpRef { name: "obscura".into(), state: "disponible".into() }];
        let mut roster = RosterState::default();
        roster.apply(vec![a]);
        assert!(roster.by_id["a"].is_operable());
        assert!(roster.blocked().is_empty());
    }

    #[test]
    fn has_tool_answers_from_the_allowlist_not_the_wide_envelope() {
        // La ficha debe reflejar `tool_allowlist_json`, que es lo estrecho. Por eso
        // la comprobación vive aquí y no se recalcula en el widget.
        let mut a = ipc_agent("a", "topo", "Topo", 2);
        a.tools = vec!["fs_read".into(), "fs_write".into()];
        let mut roster = RosterState::default();
        roster.apply(vec![a]);

        assert!(roster.by_id["a"].has_tool("fs_write"));
        assert!(!roster.by_id["a"].has_tool("browser_click"));
    }

    #[test]
    fn the_level_maps_onto_the_same_tier_scale_the_graph_uses() {
        // Ambos lados deben hablar el mismo idioma o el grafo y el roster
        // contradicen al usuario sobre quién manda sobre quién.
        assert_eq!(tier_from_level(0), AgentTier::Orchestrator);
        assert_eq!(tier_from_level(2), AgentTier::Engineering);
        assert_eq!(tier_from_level(4), AgentTier::Gate);
        // Un nivel inesperado no debe inventarse: cae en on-demand.
        assert_eq!(tier_from_level(99), AgentTier::OnDemand);
    }

    #[test]
    fn a_resend_replaces_the_roster_instead_of_accumulating() {
        // El snapshot es la verdad completa: un agente archivado debe desaparecer.
        let mut roster = RosterState::default();
        roster.apply(vec![ipc_agent("a", "backend", "Topo", 2)]);
        assert_eq!(roster.by_id.len(), 1);

        roster.apply(vec![ipc_agent("b", "frontend", "Quetzal", 2)]);
        assert_eq!(roster.by_id.len(), 1);
        assert!(roster.resolve("a").is_none(), "el agentee archivado sigue vivo");
        assert!(roster.resolve("b").is_some());
    }

    #[test]
    fn an_empty_snapshot_leaves_the_roster_empty_rather_than_panicking() {
        let mut roster = RosterState::default();
        roster.apply(vec![]);
        assert!(roster.is_empty());
        assert!(roster.agents().is_empty());
    }

    #[test]
    fn an_unknown_mcp_state_reads_as_unknown_not_as_active() {
        // Nunca "activo" por defecto: afirmar que algo está conectado cuando no
        // se sabe es peor que admitir ignorancia.
        assert_eq!(McpState::from_str("activo"), McpState::Active);
        assert_eq!(McpState::from_str(""), McpState::Unknown);
        assert_eq!(McpState::from_str("banana"), McpState::Unknown);
        assert_ne!(McpState::Unknown.glyph(), McpState::Active.glyph());
    }
}