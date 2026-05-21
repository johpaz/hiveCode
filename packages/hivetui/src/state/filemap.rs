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
}

#[derive(Debug, Default, Clone)]
pub struct FileMapState {
    pub entries: Vec<FileEntry>,
}
