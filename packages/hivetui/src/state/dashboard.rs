#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DashboardLevelStatus {
    #[default]
    Pending,
    Active,
    Done,
}

impl DashboardLevelStatus {
    pub fn from_str(value: &str) -> Self {
        match value.to_ascii_lowercase().as_str() {
            "active" | "running" | "in_progress" | "current" => Self::Active,
            "done" | "completed" | "complete" | "passed" => Self::Done,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct DashboardLevel {
    pub level: u32,
    pub label: String,
    pub agents: Vec<String>,
    pub status: DashboardLevelStatus,
}

#[derive(Debug, Clone, Default)]
pub struct BlackboardEvent {
    pub timestamp: String,
    pub agent: String,
    pub event_type: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct SecurityState {
    pub status: String,
    pub findings: u32,
}

impl Default for SecurityState {
    fn default() -> Self {
        Self {
            status: "OFFLINE".to_string(),
            findings: 0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct HaltState {
    pub active: bool,
    pub reason: Option<String>,
    pub checkpoint_id: Option<String>,
}

/// A checkpoint left available to resume by boot-time reconciliation (a task a
/// previous process left `running` without a live lease). Distinct from rollback:
/// resume continues the task from its saved level, rollback discards it.
#[derive(Debug, Clone)]
pub struct ResumeInfo {
    pub task_id: String,
    pub checkpoint_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct DashboardMetrics {
    pub elapsed_secs: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct DashboardState {
    pub levels: Vec<DashboardLevel>,
    pub blackboard_events: Vec<BlackboardEvent>,
    pub security: SecurityState,
    pub halt: HaltState,
    pub resume: Option<ResumeInfo>,
    pub metrics: DashboardMetrics,
    pub rollback_confirm_checkpoint: Option<String>,
}

impl DashboardState {
    pub fn push_blackboard_event(&mut self, event: BlackboardEvent) {
        self.blackboard_events.push(event);
        if self.blackboard_events.len() > 200 {
            let excess = self.blackboard_events.len() - 200;
            self.blackboard_events.drain(0..excess);
        }
    }
}
