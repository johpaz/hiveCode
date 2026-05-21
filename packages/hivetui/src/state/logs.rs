#[derive(Debug, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct LogState {
    pub entries: Vec<LogEntry>,
    pub visible: bool,
    pub capacity: usize,
}

impl Default for LogState {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            visible: false,
            capacity: 200,
        }
    }
}
