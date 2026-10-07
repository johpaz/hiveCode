

/// Niveles jerárquicos de agentes, ordenados de arriba (orquestador) a abajo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AgentTier {
    Orchestrator = 0, // bee
    Planning     = 1, // architecture, product_manager
    Engineering  = 2, // backend (absorbs dba), frontend (absorbs mobile), data_scientist
    Quality      = 3, // security, test, devops
    Gate         = 4, // verifier, reviewer (reviewer absorbs integration)
    OnDemand     = 5, // forensic, librarian
}

impl AgentTier {
    pub fn label(self) -> &'static str {
        match self {
            AgentTier::Orchestrator => "ORCHESTRATOR",
            AgentTier::Planning     => "PLANNING",
            AgentTier::Engineering  => "ENGINEERING",
            AgentTier::Quality      => "QUALITY",
            AgentTier::Gate         => "GATE",
            AgentTier::OnDemand     => "ON-DEMAND",
        }
    }

    pub fn all() -> &'static [AgentTier] {
        &[
            AgentTier::Orchestrator,
            AgentTier::Planning,
            AgentTier::Engineering,
            AgentTier::Quality,
            AgentTier::Gate,
            AgentTier::OnDemand,
        ]
    }
}

/// Devuelve el tier al que pertenece un worker por su nombre interno.
pub fn tier_for(name: &str) -> AgentTier {
    let lower = name.to_lowercase();
    match lower.as_str() {
        "bee" => AgentTier::Orchestrator,
        "architecture" | "product_manager" => AgentTier::Planning,
        "backend" | "frontend" | "data_scientist" => AgentTier::Engineering,
        "security" | "test" | "devops" => AgentTier::Quality,
        // El gate fused. `verifier` y `reviewer` siguen aceptándose porque un
        // plan archivado o una corrida en curso puede venir con el nombre viejo.
        "quality" | "verifier" | "reviewer" => AgentTier::Gate,
        "forensic" | "forensic_agent" | "librarian" => AgentTier::OnDemand,
        _ => AgentTier::Engineering, // fallback para agentes custom
    }
}

/// Canonical internal role id → display name. Every agent label in the app
/// comes from here.
///
/// This is the *internal* identifier made legible; Capa 2 replaces it with the
/// fauna alias that the backend ships in `roster_snapshot`, keeping the same
/// fallback for roles the swarm has never heard of.
pub fn display_name(role: &str) -> String {
    match role {
        "bee" => "Abeja Reina".to_string(),
        "product_manager" => "Ocelote".to_string(),
        "architecture" => "Cóndor".to_string(),
        "backend" => "Topo".to_string(),
        "frontend" => "Quetzal".to_string(),
        "data_scientist" => "Tecolote".to_string(),
        "security" => "Jaguar".to_string(),
        "test" => "Chapulín".to_string(),
        "devops" => "Águila".to_string(),
        "verifier" | "reviewer" | "quality" => "Puma".to_string(),
        "forensic" | "forensic_agent" => "Zorro".to_string(),
        "librarian" => "Armadillo".to_string(),
        "spider" => "Araña".to_string(),
        "scout" => "Halcón".to_string(),
        "tool" | "tool_worker" => "Cangrejo".to_string(),
        _ => capitalize(role),
    }
}

fn capitalize(s: &str) -> String {
    let mut out = s.to_string();
    if let Some(first) = out.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    out
}

/// Aristas del grafo de dependencias/colaboración entre roles.
/// (origen, destino) — la dirección indica flujo de trabajo (supervisa / colabora con).
const EDGES: &[(&str, &str)] = &[
    ("bee", "architecture"),
    ("bee", "product_manager"),
    ("product_manager", "architecture"),
    ("architecture", "backend"),
    ("architecture", "frontend"),
    ("architecture", "data_scientist"),
    ("backend", "test"),
    ("backend", "security"),
    ("frontend", "test"),
    ("frontend", "security"),
    ("data_scientist", "test"),
    ("test", "devops"),
    ("security", "devops"),
    ("devops", "quality"),
    ("quality", "bee"),
    ("quality", "librarian"),
    ("backend", "forensic"),
    ("frontend", "forensic"),
    ("test", "forensic"),
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

/// Todas las aristas del grafo de roles.
///
/// **Pendiente de consumidor** (Capa 4): este grafo es hoy una tabla fija de
/// colaboración entre roles y nada la dibuja. Capa 4 lo reemplaza por la
/// topología real del plan (`PlanPhase.depends_on`), que es lo que el usuario
/// necesita ver ("quién espera a quién"). Hasta entonces estas tres funciones son
/// API pública y por eso Rust no las marca como muertas.
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
        assert_eq!(tier_for("verifier"), AgentTier::Gate);
        assert_eq!(tier_for("reviewer"), AgentTier::Gate);
        assert_eq!(tier_for("librarian"), AgentTier::OnDemand);
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
