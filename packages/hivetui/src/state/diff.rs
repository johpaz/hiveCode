use crate::ipc::DiffLine;

#[derive(Debug, Default, Clone)]
pub struct DiffFile {
    pub path: String,
    pub branch: String,
    pub stats_added: u32,
    pub stats_removed: u32,
    pub lines: Vec<DiffLine>,
}

/// `path`/`lines`/... son la vista activa; `files` conserva cada archivo con
/// diff recibido para poder alternar entre ellos en la pestaña Código.
#[derive(Debug, Default)]
pub struct DiffState {
    pub path:   String,
    pub branch: String,
    pub stats_added: u32,
    pub stats_removed: u32,
    pub lines:  Vec<DiffLine>,
    pub scroll: usize,
    pub files: Vec<DiffFile>,
}

impl DiffState {
    /// Registra (o reemplaza por ruta) un diff y lo deja como vista activa.
    pub fn upsert(&mut self, file: DiffFile) {
        self.path = file.path.clone();
        self.branch = file.branch.clone();
        self.stats_added = file.stats_added;
        self.stats_removed = file.stats_removed;
        self.lines = file.lines.clone();
        self.scroll = 0;
        match self.files.iter_mut().find(|f| f.path == file.path) {
            Some(existing) => *existing = file,
            None => self.files.push(file),
        }
    }

    pub fn active_index(&self) -> Option<usize> {
        self.files.iter().position(|f| f.path == self.path)
    }

    /// Mueve la vista activa `delta` archivos (sin dar la vuelta).
    pub fn select_relative(&mut self, delta: isize) {
        let Some(idx) = self.active_index() else { return };
        let next = (idx as isize + delta).clamp(0, self.files.len() as isize - 1) as usize;
        if next == idx {
            return;
        }
        let file = self.files[next].clone();
        self.path = file.path;
        self.branch = file.branch;
        self.stats_added = file.stats_added;
        self.stats_removed = file.stats_removed;
        self.lines = file.lines;
        self.scroll = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, added: u32) -> DiffFile {
        DiffFile { path: path.into(), stats_added: added, ..Default::default() }
    }

    #[test]
    fn upsert_keeps_every_file_and_navigates() {
        let mut d = DiffState::default();
        d.upsert(file("a.ts", 1));
        d.upsert(file("b.ts", 2));
        d.upsert(file("a.ts", 5));
        assert_eq!(d.files.len(), 2);
        assert_eq!(d.path, "a.ts");
        assert_eq!(d.stats_added, 5);
        d.select_relative(1);
        assert_eq!(d.path, "b.ts");
        d.select_relative(1);
        assert_eq!(d.path, "b.ts");
        d.select_relative(-1);
        assert_eq!(d.path, "a.ts");
    }
}
