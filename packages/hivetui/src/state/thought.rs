#[derive(Debug, Clone)]
pub struct ThoughtChunk {
    pub coordinator: String,
    pub phase: String,
    pub content: String,
}

#[derive(Debug, Default, Clone)]
pub struct ThoughtStreamState {
    pub chunks: Vec<ThoughtChunk>,
}
