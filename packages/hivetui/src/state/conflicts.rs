#[derive(Debug, Clone)]
pub struct AgentConflict {
    pub agent: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Default, Clone)]
pub struct ConflictState {
    pub entries: Vec<AgentConflict>,
}
