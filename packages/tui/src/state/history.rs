/// Conversation role for a history entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
    Shell,
    Thinking,
}

impl From<&str> for Role {
    fn from(s: &str) -> Self {
        match s {
            "user"     => Role::User,
            "system"   => Role::System,
            "shell"    => Role::Shell,
            "thinking" => Role::Thinking,
            _          => Role::Assistant,
        }
    }
}

/// One turn in the conversation history (user message or agent response).
#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub role: Role,
    pub content: String,
    pub content_type: crate::markdown::ContentType,
    pub thinking_meta: Option<crate::markdown::ThinkingMeta>,
}

#[allow(dead_code)]
impl HistoryEntry {
    pub fn plain(role: Role, content: String) -> Self {
        Self { role, content, content_type: crate::markdown::ContentType::Plain, thinking_meta: None }
    }
    pub fn markdown(role: Role, content: String) -> Self {
        Self { role, content, content_type: crate::markdown::ContentType::Markdown, thinking_meta: None }
    }
    pub fn thinking(role: Role, content: String, meta: Option<crate::markdown::ThinkingMeta>) -> Self {
        Self { role, content, content_type: crate::markdown::ContentType::Thinking, thinking_meta: meta }
    }
    pub fn auto(role: Role, content: String) -> Self {
        let content_type = if crate::markdown::is_likely_markdown(&content) {
            crate::markdown::ContentType::Markdown
        } else {
            crate::markdown::ContentType::Plain
        };
        Self { role, content, content_type, thinking_meta: None }
    }
}
