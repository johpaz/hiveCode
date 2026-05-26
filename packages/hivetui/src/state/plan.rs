#[derive(Debug, Clone, Default)]
pub struct PlanPhase {
    pub name: String,
    pub coordinator: String,
    pub description: String,
    pub depends_on: Vec<String>,
    pub level: u32,
    pub status: String,
}

#[derive(Debug, Clone, Default)]
pub struct PlanRisk {
    pub severity: String,
    pub description: String,
}

#[derive(Debug, Clone, Default)]
pub struct PlanEntry {
    pub task_id: String,
    pub adr_title: String,
    pub adr_content: String,
    pub status: String,
    pub phases: Vec<PlanPhase>,
    pub risks: Vec<PlanRisk>,
}

#[derive(Debug, Clone, Default)]
pub struct PlanState {
    pub current: Option<PlanEntry>,
    pub selected_phase: usize,
    pub scroll: usize,
}
