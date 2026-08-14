#[derive(Debug, Clone)]
pub struct ReviewCriterion {
    pub description: String,
    pub met: bool,
    pub evidence: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ReviewCategory {
    pub name: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ReviewVerdict {
    pub reviewer: String,
    pub status: String,
    pub summary: String,
    pub observations: Vec<String>,
    pub requested_changes: Vec<String>,
    pub affected_files: Vec<String>,
    /// Structured acceptance-criteria checklist (submit_review_verdict). Empty
    /// when the reviewer model didn't call the structured tool — the view falls
    /// back to the keyword-matched `observations` heuristic in that case.
    pub criteria: Vec<ReviewCriterion>,
    pub categories: Vec<ReviewCategory>,
}

#[derive(Debug, Clone, Default)]
pub struct ReviewState {
    pub verdict: Option<ReviewVerdict>,
}
