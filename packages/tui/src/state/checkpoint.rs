/// A recorded checkpoint received from the Bun gateway.
#[derive(Debug, Clone)]
pub struct CheckpointEntry {
    pub id: String,
    pub description: String,
    pub file_count: u32,
    pub agent: String,
}

/// Capped list of checkpoints + optional selected index for rollback UI.
#[derive(Debug, Default)]
pub struct CheckpointState {
    pub entries: Vec<CheckpointEntry>,
    pub selected: Option<usize>,
}

impl CheckpointState {
    pub fn push(&mut self, entry: CheckpointEntry) {
        self.entries.push(entry);
        if self.entries.len() > 50 {
            self.entries.remove(0);
            // Adjust selection index after removal
            if let Some(sel) = self.selected {
                self.selected = if sel == 0 { None } else { Some(sel - 1) };
            }
        }
    }

    pub fn selected_id(&self) -> Option<&str> {
        self.selected
            .and_then(|i| self.entries.get(i))
            .map(|e| e.id.as_str())
    }

    pub fn select_prev(&mut self) {
        if self.entries.is_empty() { return; }
        self.selected = Some(match self.selected {
            None => self.entries.len() - 1,
            Some(i) => i.saturating_sub(1),
        });
    }

    pub fn select_next(&mut self) {
        if self.entries.is_empty() { return; }
        self.selected = Some(match self.selected {
            None => 0,
            Some(i) => (i + 1).min(self.entries.len() - 1),
        });
    }
}
