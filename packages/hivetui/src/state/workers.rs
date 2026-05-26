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
