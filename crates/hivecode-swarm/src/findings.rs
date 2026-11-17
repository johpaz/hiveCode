//! Saved reports of readers (scouts): the same question over files that did not change is answered
//! from the saved report instead of reading the code again.
//!
//! A report is reusable only when the task names files that exist and every one of them is exactly
//! as it was (its content, not its modification time). A question that names no file is never reused: nothing
//! says what would make the answer stale. In memory for now; it lives as long as the process.
use std::{
    collections::HashSet,
    path::Path,
    sync::{LazyLock, Mutex},
};

const MAX_FILES: usize = 50;

/// `(path, hash of the content, length)`: what a file *is*, not when it was written. Every run works
/// in a fresh copy of the project, where every modification time is new.
pub type Fingerprint = Vec<(String, Option<u64>, u64)>;

/// A report as it is saved elsewhere.
#[derive(Clone, Debug, PartialEq)]
pub struct Saved {
    pub worker: String,
    pub key: String,
    pub files: Vec<(String, Option<u64>, u64)>,
    pub handoff: String,
}

/// Where reports outlive the process. `load` runs once, when the swarm starts; `save` on each new
/// report. Failures are the backend's to swallow: a report that is not saved is only not reused.
pub trait Backend: Send + Sync {
    fn load(&self) -> Vec<Saved>;
    fn save(&self, report: &Saved);
}

struct Finding {
    worker: String,
    key: String,
    files: Fingerprint,
    handoff: String,
}

#[derive(Default)]
pub struct Findings {
    items: Mutex<Vec<Finding>>,
    backend: Option<std::sync::Arc<dyn Backend>>,
}

static PATHLIKE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"[A-Za-z0-9_@./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8}\b|[A-Za-z0-9_@.-]+/[A-Za-z0-9_@./-]+",
    )
    .unwrap()
});

/// The existing project files a text names, relative to `root` (at most 50, in order of appearance).
pub fn files_named(root: &Path, text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for m in PATHLIKE.find_iter(text) {
        let candidate = m
            .as_str()
            .trim_matches(['.', '/', ',', ';', ':', ')', '(', '`', '"', '\''])
            .to_owned();
        if candidate.is_empty() || candidate.contains("..") || Path::new(&candidate).is_absolute() {
            continue;
        }
        if seen.insert(candidate.clone()) && root.join(&candidate).is_file() {
            out.push(candidate);
            if out.len() == MAX_FILES {
                break;
            }
        }
    }
    out
}

pub fn fingerprint(root: &Path, files: &[String]) -> Fingerprint {
    files
        .iter()
        .map(|f| match std::fs::read(root.join(f)) {
            Ok(bytes) => (f.clone(), Some(fnv(&bytes)), bytes.len() as u64),
            Err(_) => (f.clone(), None, 0),
        })
        .collect()
}

/// FNV-1a 64: stable across runs and Rust versions, which is what a saved fingerprint needs.
fn fnv(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn normalise(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

impl Findings {
    /// Starts with what the backend already holds and writes every new report through to it.
    pub fn with_backend(backend: std::sync::Arc<dyn Backend>) -> Self {
        let items = backend
            .load()
            .into_iter()
            .map(|s| Finding {
                worker: s.worker,
                key: s.key,
                files: s.files,
                handoff: s.handoff,
            })
            .collect();
        Self {
            items: Mutex::new(items),
            backend: Some(backend),
        }
    }

    pub fn key(description: &str, context: &str) -> String {
        normalise(&format!("{description}\n{context}"))
    }

    /// The saved report for this question, if every file it covers is unchanged.
    pub fn lookup(&self, worker: &str, key: &str, root: &Path) -> Option<String> {
        let items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        items
            .iter()
            .rev()
            .find(|f| {
                f.worker == worker
                    && f.key == key
                    && !f.files.is_empty()
                    && fingerprint(
                        root,
                        &f.files.iter().map(|(p, ..)| p.clone()).collect::<Vec<_>>(),
                    ) == f.files
            })
            .map(|f| f.handoff.clone())
    }

    pub fn store(&self, worker: &str, key: &str, files: Fingerprint, handoff: &str) {
        if files.is_empty() || handoff.trim().is_empty() {
            return;
        }
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        items.retain(|f| !(f.worker == worker && f.key == key));
        if let Some(backend) = &self.backend {
            backend.save(&Saved {
                worker: worker.to_owned(),
                key: key.to_owned(),
                files: files.clone(),
                handoff: handoff.to_owned(),
            });
        }
        items.push(Finding {
            worker: worker.to_owned(),
            key: key.to_owned(),
            files,
            handoff: handoff.to_owned(),
        });
    }
}
