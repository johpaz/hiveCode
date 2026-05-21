/// A single log line forwarded from the Bun gateway.
#[derive(Debug, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

/// Capped ring-buffer of recent log entries.
#[derive(Debug, Default)]
pub struct LogState {
    pub entries: Vec<LogEntry>,
    pub visible: bool,
    capacity: usize,
}

impl LogState {
    pub fn new(capacity: usize) -> Self {
        Self { entries: Vec::new(), visible: false, capacity }
    }

    pub fn push(&mut self, entry: LogEntry) {
        self.entries.push(entry);
        if self.entries.len() > self.capacity {
            self.entries.remove(0);
        }
    }

    pub fn toggle(&mut self) {
        self.visible = !self.visible;
    }
}
