/// A file touched by an agent during this session, with its risk level.
#[derive(Debug, Clone)]
pub struct FileRiskEntry {
    pub path: String,
    pub risk: String,
    pub operation: String,
    pub agent: String,
}

/// Map of all files accessed/modified in the session with their risk levels.
/// Used by the file-map widget to visualise agent activity.
#[derive(Debug, Default)]
pub struct FileMapState {
    pub entries: Vec<FileRiskEntry>,
}

impl FileMapState {
    pub fn update(&mut self, path: String, risk: String, operation: String, agent: String) {
        if let Some(existing) = self.entries.iter_mut().find(|e| e.path == path) {
            existing.risk = risk;
            existing.operation = operation;
            existing.agent = agent;
        } else {
            self.entries.push(FileRiskEntry { path, risk, operation, agent });
        }
    }

    pub fn by_risk(&self, level: &str) -> Vec<&FileRiskEntry> {
        self.entries.iter().filter(|e| e.risk == level).collect()
    }
}
