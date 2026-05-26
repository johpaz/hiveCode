#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RiskLevel {
    #[default]
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: String,
    pub risk: RiskLevel,
    pub operation: String,
    pub agent: String,
    pub adr_ref: Option<String>,
    pub lines_added: u32,
    pub lines_removed: u32,
}

#[derive(Debug, Default, Clone)]
pub struct FileMapState {
    pub entries: Vec<FileEntry>,
}
