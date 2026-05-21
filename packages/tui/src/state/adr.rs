/// A file-risk entry derived from ADR analysis.
#[derive(Debug, Clone)]
pub struct AdrRisk {
    pub path: String,
    pub risk: String,
    pub reason: String,
    pub agent: String,
    pub operation: String,
}

/// Tracks ADR-based risk assessments for files touched in the session.
#[derive(Debug, Default)]
pub struct AdrState {
    pub risks: Vec<AdrRisk>,
}

impl AdrState {
    pub fn update(
        &mut self,
        path: String,
        risk: String,
        reason: String,
        agent: String,
        operation: String,
    ) {
        if let Some(existing) = self.risks.iter_mut().find(|e| e.path == path) {
            existing.risk = risk;
            existing.reason = reason;
            existing.agent = agent;
            existing.operation = operation;
        } else {
            self.risks.push(AdrRisk { path, risk, reason, agent, operation });
        }
    }

    pub fn critical_count(&self) -> usize {
        self.risks.iter().filter(|r| r.risk == "critical" || r.risk == "high").count()
    }
}
