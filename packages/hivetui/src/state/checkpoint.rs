#[derive(Debug, Clone)]
pub struct Checkpoint {
    pub id: String,
    pub description: String,
    pub file_count: u32,
    pub agent: String,
    pub time: String,
}

#[derive(Debug, Default, Clone)]
pub struct CheckpointState {
    pub entries: Vec<Checkpoint>,
    pub selected: Option<usize>,
}

impl CheckpointState {
    pub fn push(&mut self, checkpoint: Checkpoint) {
        self.entries.push(checkpoint);
        if self.entries.len() > 50 {
            self.entries.remove(0);

            if let Some(selected) = self.selected {
                self.selected = selected.checked_sub(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_state_caps_entries_at_fifty() {
        let mut state = CheckpointState::default();

        for index in 0..55 {
            state.push(Checkpoint {
                id: format!("cp-{index}"),
                description: format!("checkpoint {index}"),
                file_count: index,
                agent: "bee".to_string(),
                time: String::new(),
            });
        }

        assert_eq!(state.entries.len(), 50);
        assert_eq!(state.entries.first().map(|entry| entry.id.as_str()), Some("cp-5"));
        assert_eq!(state.entries.last().map(|entry| entry.id.as_str()), Some("cp-54"));
    }
}
