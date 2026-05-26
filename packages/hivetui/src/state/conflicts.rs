#[derive(Debug, Clone)]
pub struct AgentConflict {
    pub agent_a: String,
    pub agent_b: String,
    pub path: String,
    pub reason: String,
    pub severity: String,
    pub detail: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct ConflictState {
    pub entries: Vec<AgentConflict>,
}
