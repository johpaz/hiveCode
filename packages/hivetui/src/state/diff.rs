use crate::ipc::DiffLine;

#[derive(Debug, Default)]
pub struct DiffState {
    pub path:   String,
    pub lines:  Vec<DiffLine>,
    pub scroll: usize,
}
