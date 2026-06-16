#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WorkerStatus {
    #[default]
    Waiting,
    Running,
    Done,
    Failed,
    Warn,
}

impl WorkerStatus {
    pub fn emoji(&self) -> &'static str {
        match self {
            WorkerStatus::Waiting => "⏳",
            WorkerStatus::Running => "▶",
            WorkerStatus::Done => "✓",
            WorkerStatus::Failed => "✗",
            WorkerStatus::Warn => "⚠",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Worker {
    pub name: String,
    pub display_name: String,
    pub status: WorkerStatus,
    pub detail: Option<String>,
    pub activity: Option<String>,
    pub token_count: u64,
    pub level: Option<u32>,
    pub current_action: Option<String>,
    pub current_file: Option<String>,
    pub iteration_current: Option<u32>,
    pub iteration_total: Option<u32>,
    pub transversal: bool,
    pub replaces_worker: Option<String>,
}

impl Worker {
    pub fn new(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            display_name: name.clone(),
            name,
            status: WorkerStatus::Waiting,
            detail: None,
            activity: None,
            token_count: 0,
            level: None,
            current_action: None,
            current_file: None,
            iteration_current: None,
            iteration_total: None,
            transversal: false,
            replaces_worker: None,
        }
    }
}

impl Default for Worker {
    fn default() -> Self {
        Self::new("")
    }
}

#[derive(Debug, Default, Clone)]
pub struct WorkerState {
    pub active_coordinator: String,
    pub active_phase: String,
    pub activity_status: String,
    pub workers: Vec<Worker>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_status_emoji_matches_state() {
        assert_eq!(WorkerStatus::Waiting.emoji(), "⏳");
        assert_eq!(WorkerStatus::Running.emoji(), "▶");
        assert_eq!(WorkerStatus::Done.emoji(), "✓");
        assert_eq!(WorkerStatus::Failed.emoji(), "✗");
    }
}
