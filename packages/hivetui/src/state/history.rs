#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
    Shell,
    Thinking,
}

impl From<&str> for Role {
    fn from(value: &str) -> Self {
        match value {
            "user" => Role::User,
            "system" => Role::System,
            "shell" => Role::Shell,
            "thinking" => Role::Thinking,
            _ => Role::Assistant,
        }
    }
}

#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Default, Clone)]
pub struct HistoryState {
    pub entries: Vec<HistoryEntry>,
    pub selected: Option<usize>,
}
