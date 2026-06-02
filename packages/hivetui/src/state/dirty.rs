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
    pub adrs: bool,
    pub diff: bool,
    pub full: bool,
    /// CODE tab received new search/narrative results
    pub search_results: bool,
    /// Only the thought stream header changed (avoid full history repaint)
    pub thought_header: bool,
}
