#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessHealth {
    MissingProvider,
    Starting,
    Running,
    Approval,
    Error,
    Ready,
}

#[derive(Debug, Clone)]
pub struct HarnessState {
    pub ipc_connected: bool,
    pub event_count: u64,
    pub last_event_type: String,
    pub last_event_at: String,
    pub active_task_id: Option<String>,
    pub active_task_title: Option<String>,
    pub active_task_status: Option<String>,
    pub active_workspace_status: Option<String>,
    pub active_workspace_path: Option<String>,
    pub approval_pending: bool,
    pub last_agent: Option<String>,
    pub last_phase: Option<String>,
    pub last_activity: Option<String>,
}

impl Default for HarnessState {
    fn default() -> Self {
        Self {
            ipc_connected: false,
            event_count: 0,
            last_event_type: "boot".to_string(),
            last_event_at: "--:--:--".to_string(),
            active_task_id: None,
            active_task_title: None,
            active_task_status: None,
            active_workspace_status: None,
            active_workspace_path: None,
            approval_pending: false,
            last_agent: None,
            last_phase: None,
            last_activity: None,
        }
    }
}

impl HarnessState {
    pub fn record_event(&mut self, event_type: &'static str) {
        self.ipc_connected = true;
        self.event_count = self.event_count.saturating_add(1);
        self.last_event_type = event_type.to_string();
        self.last_event_at = chrono::Local::now().format("%H:%M:%S").to_string();
    }

    pub fn health(&self, provider: &str, running: bool) -> HarnessHealth {
        if provider.trim().is_empty() {
            HarnessHealth::MissingProvider
        } else if self
            .active_workspace_status
            .as_deref()
            .is_some_and(|status| status == "error" || status == "conflict")
        {
            HarnessHealth::Error
        } else if self.approval_pending {
            HarnessHealth::Approval
        } else if running {
            HarnessHealth::Running
        } else if !self.ipc_connected {
            HarnessHealth::Starting
        } else {
            HarnessHealth::Ready
        }
    }

    pub fn health_label(&self, provider: &str, running: bool) -> &'static str {
        match self.health(provider, running) {
            HarnessHealth::MissingProvider => "sin provider",
            HarnessHealth::Starting => "arrancando",
            HarnessHealth::Running => "ejecutando",
            HarnessHealth::Approval => "requiere aprobacion",
            HarnessHealth::Error => "requiere revision",
            HarnessHealth::Ready => "listo",
        }
    }

    pub fn task_label(&self) -> String {
        match (
            self.active_task_title.as_deref(),
            self.active_task_id.as_deref(),
            self.active_task_status.as_deref(),
        ) {
            (Some(title), Some(task_id), Some(status)) => {
                format!("{title} · {task_id} · {status}")
            }
            (Some(title), _, Some(status)) => format!("{title} · {status}"),
            (_, Some(task_id), Some(status)) => format!("{task_id} · {status}"),
            (Some(title), _, _) => title.to_string(),
            (_, Some(task_id), _) => task_id.to_string(),
            _ => "sin tarea activa".to_string(),
        }
    }

    pub fn workspace_label(&self) -> String {
        match (
            self.active_workspace_status.as_deref(),
            self.active_workspace_path.as_deref(),
        ) {
            (Some(status), Some(path)) => format!("{status} · {path}"),
            (Some(status), None) => status.to_string(),
            (None, Some(path)) => path.to_string(),
            _ => "workspace principal".to_string(),
        }
    }

    pub fn event_label(&self) -> String {
        if self.event_count == 0 {
            "sin eventos IPC".to_string()
        } else {
            format!(
                "{} · #{} · {}",
                self.last_event_type, self.event_count, self.last_event_at
            )
        }
    }

    pub fn activity_label(&self) -> String {
        match (
            self.last_agent.as_deref(),
            self.last_phase.as_deref(),
            self.last_activity.as_deref(),
        ) {
            (Some(agent), Some(phase), Some(activity)) => format!("{agent} · {phase} · {activity}"),
            (Some(agent), Some(phase), None) => format!("{agent} · {phase}"),
            (Some(agent), None, Some(activity)) => format!("{agent} · {activity}"),
            (Some(agent), None, None) => agent.to_string(),
            _ => "sin actividad".to_string(),
        }
    }
}
