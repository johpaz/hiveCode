//! Delegations that outlive the process, so `task_revise` still works after `hivecode` restarts.
//!
//! What is saved is only what is needed to resume a worker: its session (the SDK keeps the
//! conversation itself), which profile and ref it was, and the private copy that was kept if its work
//! could not be merged. A kept copy that no longer exists on disk is forgotten on load.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedCopy {
    pub workspace_id: String,
    pub task_id: String,
    pub project: String,
    pub worktree: String,
    pub branch: String,
    pub baseline_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedRecord {
    pub id: String,
    pub reference: String,
    pub worker: String,
    pub session: String,
    pub runs: u32,
    pub ok: bool,
    pub kept: Option<SavedCopy>,
}

/// Where delegations are kept. Failures are the backend's to swallow: a record that is not saved is
/// only not revisable after a restart.
pub trait Backend: Send + Sync {
    fn load(&self) -> Vec<SavedRecord>;
    fn save(&self, record: &SavedRecord);
}
