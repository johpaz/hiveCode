#[derive(Debug, Clone, Default)]
pub struct ReviewVerdict {
    pub reviewer: String,
    pub status: String,
    pub summary: String,
    pub observations: Vec<String>,
    pub requested_changes: Vec<String>,
    pub affected_files: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ReviewState {
    pub verdict: Option<ReviewVerdict>,
}
