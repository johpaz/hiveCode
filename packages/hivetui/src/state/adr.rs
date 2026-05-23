#[derive(Debug, Clone, Default)]
pub struct AdrEntry {
    pub path:    String,
    pub title:   String,
    pub content: String,
    pub status:  String,
}

#[derive(Debug, Default)]
pub struct AdrState {
    pub entries:  Vec<AdrEntry>,
    pub selected: usize,
    pub scroll:   usize,
}
