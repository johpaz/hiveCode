/// Bitmask of which AppState sections changed since the last render.
/// Lets the renderer skip unchanged sections for efficiency.
#[derive(Debug, Default)]
pub struct DirtyFlags {
    pub history: bool,
    pub input: bool,
    pub status: bool,
    pub session: bool,
    pub workers: bool,
    pub logs: bool,
    pub modal: bool,
    pub checkpoint: bool,
}

impl DirtyFlags {
    pub fn any(&self) -> bool {
        self.history
            || self.input
            || self.status
            || self.session
            || self.workers
            || self.logs
            || self.modal
            || self.checkpoint
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn all() -> Self {
        Self {
            history: true,
            input: true,
            status: true,
            session: true,
            workers: true,
            logs: true,
            modal: true,
            checkpoint: true,
        }
    }
}
