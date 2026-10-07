#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WorkerStatus {
    #[default]
    Waiting,
    Running,
    Done,
    Failed,
    Warn,
}

impl WorkerStatus {
    pub fn emoji(&self) -> &'static str {
        match self {
            WorkerStatus::Waiting => "⏳",
            WorkerStatus::Running => "▶",
            WorkerStatus::Done => "✓",
            WorkerStatus::Failed => "✗",
            WorkerStatus::Warn => "⚠",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Worker {
    pub name: String,
    pub display_name: String,
    pub status: WorkerStatus,
    pub detail: Option<String>,
    pub activity: Option<String>,
    pub token_count: u64,
    pub level: Option<u32>,
    pub current_action: Option<String>,
    pub current_file: Option<String>,
    pub iteration_current: Option<u32>,
    pub iteration_total: Option<u32>,
    pub transversal: bool,
    pub replaces_worker: Option<String>,
}

impl Worker {
    /// `display_name` arranca como el alias legible, no como el nombre interno.
    ///
    /// Con el nombre crudo, una tarjeta se pintaba "@BACKEND" y la tabla de
    /// alias nunca se consultaba: `worker_display_name` solo cae al alias cuando
    /// `display_name` está vacío. Fijar el invariante aquí lo corrige en todas
    /// las rutas de creación de una vez.
    pub fn new(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            display_name: super::agent_display_name(&name),
            name,
            status: WorkerStatus::Waiting,
            detail: None,
            activity: None,
            token_count: 0,
            level: None,
            current_action: None,
            current_file: None,
            iteration_current: None,
            iteration_total: None,
            transversal: false,
            replaces_worker: None,
        }
    }
}

impl Default for Worker {
    fn default() -> Self {
        Self::new("")
    }
}

#[derive(Debug, Default, Clone)]
pub struct WorkerState {
    pub active_coordinator: String,
    pub active_phase: String,
    pub activity_status: String,
    pub workers: Vec<Worker>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_worker_starts_with_a_readable_name_not_the_raw_id() {
        // Con el nombre crudo, la tarjeta se pintaba "@BACKEND": `worker_display_name`
        // solo cae a la tabla de alias cuando `display_name` está vacío, y aquí
        // nunca lo estaba.
        let w = Worker::new("backend");
        assert_eq!(w.name, "backend");
        assert_eq!(w.display_name, "Topo");
        assert_ne!(w.display_name, w.name);
    }

    #[test]
    fn every_known_role_gets_its_alias_on_creation() {
        for (rol, alias) in [
            ("bee", "Abeja Reina"),
            ("backend", "Topo"),
            ("frontend", "Quetzal"),
            ("security", "Jaguar"),
            ("quality", "Puma"),
        ] {
            assert_eq!(Worker::new(rol).display_name, alias, "{rol}");
        }
    }

    #[test]
    fn an_unknown_role_still_gets_a_non_empty_label() {
        let w = Worker::new("agente_nuevo");
        assert!(!w.display_name.is_empty());
    }
}
