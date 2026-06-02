#![allow(dead_code)]

use crate::term::{Color, AMBER_BRIGHT, BLUE, CYAN, GREEN, LAVENDER, PINK, PURPLE, RED, SECONDARY, YELLOW};

/// Niveles jerárquicos de agentes, ordenados de arriba (orquestador) a abajo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AgentTier {
    Orchestrator = 0, // bee
    Planning     = 1, // architecture, product_manager
    Engineering  = 2, // backend, frontend, mobile, data_scientist, dba, integration
    Quality      = 3, // security, test, devops
    Gate         = 4, // reviewer
}

impl AgentTier {
    pub fn label(self) -> &'static str {
        match self {
            AgentTier::Orchestrator => "ORCHESTRATOR",
            AgentTier::Planning     => "PLANNING",
            AgentTier::Engineering  => "ENGINEERING",
            AgentTier::Quality      => "QUALITY",
            AgentTier::Gate         => "GATE",
        }
    }

    pub fn all() -> &'static [AgentTier] {
        &[
            AgentTier::Orchestrator,
            AgentTier::Planning,
            AgentTier::Engineering,
            AgentTier::Quality,
            AgentTier::Gate,
        ]
    }
}

/// Devuelve el tier al que pertenece un worker por su nombre interno.
pub fn tier_for(name: &str) -> AgentTier {
    let lower = name.to_lowercase();
    match lower.as_str() {
        "bee" => AgentTier::Orchestrator,
        "architecture" | "product_manager" => AgentTier::Planning,
        "backend" | "frontend" | "mobile" | "data_scientist" | "dba" | "integration" => AgentTier::Engineering,
        "security" | "test" | "devops" => AgentTier::Quality,
        "reviewer" => AgentTier::Gate,
        _ => AgentTier::Engineering, // fallback para agentes custom
    }
}

/// Display name legible para un agente.
pub fn display_name(name: &str) -> String {
    match name {
        "bee" => "Bee".to_string(),
        "architecture" => "Architecture".to_string(),
        "backend" => "BackendEngineer".to_string(),
        "frontend" => "FrontendEngineer".to_string(),
        "security" => "SecurityAuditor".to_string(),
        "test" => "QAEngineer".to_string(),
        "devops" => "DevOpsEngineer".to_string(),
        "product_manager" => "ProductManager".to_string(),
        "mobile" => "MobileEngineer".to_string(),
        "data_scientist" => "DataScientist".to_string(),
        "dba" => "DBA".to_string(),
        "integration" => "IntegrationEngineer".to_string(),
        "reviewer" => "Reviewer".to_string(),
        _ => {
            let mut s = name.to_string();
            if let Some(first) = s.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            s
        }
    }
}

/// Color identificador para un agente.
pub fn agent_color(name: &str) -> Color {
    const ROLES: &[(&str, Color)] = &[
        ("bee", AMBER_BRIGHT),
        ("arch", PURPLE),
        ("back", BLUE),
        ("front", CYAN),
        ("sec", PINK),
        ("test", YELLOW),
        ("devops", LAVENDER),
        ("product", GREEN),
        ("mobile", RED),
        ("data", SECONDARY),
        ("dba", SECONDARY),
        ("integration", SECONDARY),
        ("reviewer", AMBER_BRIGHT),
    ];
    ROLES
        .iter()
        .find(|(key, _)| name.to_lowercase().contains(key))
        .map(|(_, color)| *color)
        .unwrap_or(SECONDARY)
}

/// Aristas del grafo de dependencias/colaboración entre roles.
/// (origen, destino) — la dirección indica flujo de trabajo (supervisa / colabora con).
const EDGES: &[(&str, &str)] = &[
    ("bee", "architecture"),
    ("bee", "product_manager"),
    ("product_manager", "architecture"),
    ("architecture", "backend"),
    ("architecture", "frontend"),
    ("architecture", "mobile"),
    ("architecture", "data_scientist"),
    ("architecture", "dba"),
    ("architecture", "integration"),
    ("backend", "test"),
    ("backend", "security"),
    ("frontend", "test"),
    ("frontend", "security"),
    ("mobile", "test"),
    ("mobile", "security"),
    ("data_scientist", "test"),
    ("dba", "test"),
    ("integration", "test"),
    ("test", "devops"),
    ("security", "devops"),
    ("devops", "reviewer"),
    ("test", "reviewer"),
    ("reviewer", "bee"),
];

/// Devuelve los destinos conectados desde un agente.
pub fn edges_from(name: &str) -> Vec<&'static str> {
    EDGES
        .iter()
        .filter(|(src, _)| name.to_lowercase() == *src)
        .map(|(_, dst)| *dst)
        .collect()
}

/// Devuelve los orígenes que conectan hacia un agente.
pub fn edges_to(name: &str) -> Vec<&'static str> {
    EDGES
        .iter()
        .filter(|(_, dst)| name.to_lowercase() == *dst)
        .map(|(src, _)| *src)
        .collect()
}

/// Todas las aristas del grafo.
pub fn all_edges() -> &'static [(&'static str, &'static str)] {
    EDGES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_groups_are_correct() {
        assert_eq!(tier_for("bee"), AgentTier::Orchestrator);
        assert_eq!(tier_for("architecture"), AgentTier::Planning);
        assert_eq!(tier_for("backend"), AgentTier::Engineering);
        assert_eq!(tier_for("test"), AgentTier::Quality);
        assert_eq!(tier_for("reviewer"), AgentTier::Gate);
    }

    #[test]
    fn edges_exist_for_known_roles() {
        let arch_out = edges_from("architecture");
        assert!(arch_out.contains(&"backend"));
        assert!(arch_out.contains(&"frontend"));

        let test_in = edges_to("test");
        assert!(test_in.contains(&"backend"));
        assert!(test_in.contains(&"frontend"));
    }

    #[test]
    fn custom_agent_fallbacks_to_engineering() {
        assert_eq!(tier_for("custom_bot"), AgentTier::Engineering);
    }
}
