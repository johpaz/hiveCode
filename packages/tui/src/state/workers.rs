/// One phase in the multi-coordinator pipeline.
#[derive(Debug, Clone)]
pub struct Phase {
    pub name: String,
    pub coordinator: String,
    pub status: String,
    pub duration_ms: Option<u64>,
}

/// Live state of the active coordinator and phase pipeline.
#[derive(Debug)]
pub struct WorkerState {
    pub active_coordinator: String,
    pub active_phase: String,
    pub activity_status: String,
    pub phases: Vec<Phase>,
}

impl Default for WorkerState {
    fn default() -> Self {
        Self {
            active_coordinator: String::new(),
            active_phase: String::new(),
            activity_status: "idle".to_string(),
            phases: vec![
                Phase { name: "Analyze & Route".into(),          coordinator: "bee".into(),          status: "idle".into(), duration_ms: None },
                Phase { name: "Architecture Design".into(),      coordinator: "architecture".into(), status: "idle".into(), duration_ms: None },
                Phase { name: "Backend Implementation".into(),   coordinator: "backend".into(),      status: "idle".into(), duration_ms: None },
                Phase { name: "Frontend Implementation".into(),  coordinator: "frontend".into(),     status: "idle".into(), duration_ms: None },
                Phase { name: "Security Audit".into(),           coordinator: "security".into(),     status: "idle".into(), duration_ms: None },
                Phase { name: "Testing".into(),                  coordinator: "test".into(),         status: "idle".into(), duration_ms: None },
                Phase { name: "DevOps Deploy".into(),            coordinator: "devops".into(),       status: "idle".into(), duration_ms: None },
            ],
        }
    }
}

impl WorkerState {
    /// Update coordinator activity and sync the phases vec.
    pub fn update(&mut self, coordinator: String, phase: String, status: String) {
        self.active_coordinator = coordinator.clone();
        self.active_phase = phase.clone();
        self.activity_status = status.clone();
        for p in &mut self.phases {
            if p.coordinator == coordinator {
                p.status = status.clone();
                p.name = phase.clone();
            }
        }
    }
}
