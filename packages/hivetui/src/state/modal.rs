#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ModalFieldKind {
    #[default]
    Text,
    Secret,
    Select,
}

#[derive(Debug, Clone, Default)]
pub struct ModalField {
    pub key: String,
    pub label: String,
    pub kind: ModalFieldKind,
    pub required: bool,
    pub default_value: Option<String>,
    pub options: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigModalState {
    pub command: String,
    pub title: String,
    pub fields: Vec<ModalField>,
    pub values: Vec<String>,
    pub cursors: Vec<usize>,
    pub focused: usize,
    pub errors: Vec<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct InfoModalState {
    pub title: String,
    pub content: String,
    pub scroll: usize,
}

#[derive(Debug, Clone, Default)]
pub enum ModalState {
    #[default]
    None,
    Config(ConfigModalState),
    Info(InfoModalState),
}
