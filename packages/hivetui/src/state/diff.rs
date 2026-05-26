use crate::ipc::DiffLine;

#[derive(Debug, Default)]
pub struct DiffState {
    pub path:   String,
    pub branch: String,
    pub stats_added: u32,
    pub stats_removed: u32,
    pub lines:  Vec<DiffLine>,
    pub scroll: usize,
}
