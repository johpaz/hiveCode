/// One reasoning chunk streamed from a coordinator.
#[derive(Debug, Clone)]
pub struct NarrativeChunk {
    pub coordinator: String,
    pub phase: String,
    pub content: String,
}

/// Capped ring-buffer of narrative (thinking) chunks shown in the thought-stream panel.
#[derive(Debug, Default)]
pub struct ThoughtStreamState {
    pub chunks: Vec<NarrativeChunk>,
}

impl ThoughtStreamState {
    pub fn push(&mut self, coordinator: String, phase: String, content: String) {
        self.chunks.push(NarrativeChunk { coordinator, phase, content });
        if self.chunks.len() > 100 {
            self.chunks.remove(0);
        }
    }

    pub fn clear(&mut self) {
        self.chunks.clear();
    }

    /// Returns all content joined for the last coordinator run.
    pub fn current_text(&self) -> String {
        self.chunks.iter().map(|c| c.content.as_str()).collect::<Vec<_>>().join("")
    }
}
