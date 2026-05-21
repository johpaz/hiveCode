#[derive(Debug, Default, Clone)]
pub struct DirtyFlags {
    pub session: bool,
    pub input: bool,
    pub history: bool,
    pub checkpoints: bool,
    pub workers: bool,
    pub filemap: bool,
    pub thought: bool,
    pub conflicts: bool,
    pub modal: bool,
    pub logs: bool,
    pub mascot: bool,
}
