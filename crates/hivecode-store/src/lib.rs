//! hivecode's own data, on the same HiveDB the SDK keeps its sessions in.
//!
//! One database is opened once per process and shared: the SDK's `SessionStore` (agent sessions,
//! checkpoints, the shared budget) and hivecode's collections live side by side. Collections are
//! versioned by name (`hivecode_*_v1`); a format change makes a `_v2`, never an in-place rewrite.
//!
//! - `runs`: one document per `hivecode run`, for `hivecode history`.
//! - `findings`: scout reports that outlive the process, per project (see `hivecode-swarm`).
//! - `delegations`: what a worker needs to be resumed (`task_revise` after a restart).
//! - `patches`: what a run integrated into the project, so `hivecode rollback` can undo it.
use hive_agent_core::sessions::SessionStore;
use hivecode_swarm::{
    findings::{Backend, Saved},
    records::{Backend as RecordsBackend, SavedRecord},
};
use hivedb_core::{HiveDB, PutOptions, ScanOptions};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;

const RUNS: &str = "hivecode_runs_v1";
const FINDINGS: &str = "hivecode_findings_v1";
const PATCHES: &str = "hivecode_patches_v1";
const DELEGATIONS: &str = "hivecode_delegations_v1";
/// A patch larger than this is not kept (the run is still recorded, just not undoable).
pub const MAX_PATCH_BYTES: usize = 8 * 1024 * 1024;

fn db_err(e: impl std::fmt::Display) -> Error {
    e.to_string().into()
}

#[derive(Clone)]
pub struct Store {
    db: Arc<HiveDB>,
    sessions: hivecode_host::Store,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RunDoc {
    pub id: String,
    pub project: String,
    pub objective: String,
    pub mode: String,
    pub swarm: bool,
    pub started_ms: u64,
    pub finished_ms: u64,
    /// The harness status (`completed`, `failed`, `ready`, `waitinguser`) or `completed` for a plain run.
    pub status: String,
    pub route: Option<String>,
    pub repair_cycles: u32,
    /// `integrated`, `noop`, `conflict` or `failed`.
    pub integration: String,
    pub budget: Option<Value>,
    pub response: String,
    /// The session of the lead agent. A run starts its own; a resumed run keeps the one it continues,
    /// so the lead remembers the whole conversation.
    pub lead_session: String,
    /// The run this one continues, if it was resumed.
    pub resumed_from: Option<String>,
    /// A patch is kept for this run, so it can be rolled back.
    pub has_patch: bool,
    pub rolled_back: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PatchDoc {
    pub run_id: String,
    pub project: String,
    pub diff: String,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Arc::new(HiveDB::open(path).map_err(db_err)?);
        let sessions = SessionStore::from_db(db.clone(), "hivecode".to_owned())?;
        Ok(Self {
            db,
            sessions: Arc::new(Mutex::new(Some(sessions))),
        })
    }

    /// The SDK session store, to hand to hosts and the swarm.
    pub fn sessions(&self) -> hivecode_host::Store {
        self.sessions.clone()
    }

    fn put<T: Serialize>(&self, collection: &str, id: &str, doc: &T) -> Result<()> {
        self.db
            .col_put(
                collection,
                id,
                &serde_json::to_value(doc)?,
                PutOptions::default(),
            )
            .map_err(db_err)?;
        Ok(())
    }
    fn get<T: DeserializeOwned>(&self, collection: &str, id: &str) -> Result<Option<T>> {
        self.db
            .col_get(collection, id)
            .map_err(db_err)?
            .map(|entry| serde_json::from_value(entry.doc).map_err(Error::from))
            .transpose()
    }

    pub fn record_run(&self, run: &RunDoc) -> Result<()> {
        self.put(RUNS, &run.id, run)
    }
    pub fn run(&self, id: &str) -> Result<Option<RunDoc>> {
        self.get(RUNS, id)
    }
    /// The newest runs first (ids start with the start time, so id order is time order).
    pub fn runs(&self, limit: usize) -> Result<Vec<RunDoc>> {
        let options = ScanOptions {
            limit,
            reverse: true,
            ..Default::default()
        };
        self.db
            .col_scan(RUNS, &options)
            .map_err(db_err)?
            .into_iter()
            .map(|e| serde_json::from_value(e.doc).map_err(Error::from))
            .collect()
    }

    /// Keeps what a run integrated, unless it is too large to keep. Returns whether it was kept.
    pub fn save_patch(&self, run_id: &str, project: &str, diff: &str) -> Result<bool> {
        if diff.trim().is_empty() || diff.len() > MAX_PATCH_BYTES {
            return Ok(false);
        }
        self.put(
            PATCHES,
            run_id,
            &PatchDoc {
                run_id: run_id.into(),
                project: project.into(),
                diff: diff.into(),
            },
        )?;
        Ok(true)
    }
    pub fn patch(&self, run_id: &str) -> Result<Option<PatchDoc>> {
        self.get(PATCHES, run_id)
    }
    pub fn mark_rolled_back(&self, run_id: &str) -> Result<()> {
        let mut run = self.run(run_id)?.ok_or("unknown run")?;
        run.rolled_back = true;
        self.record_run(&run)
    }

    /// The delegations of one lead session, for the swarm.
    pub fn records_for(&self, lead_session: &str) -> Arc<dyn RecordsBackend> {
        Arc::new(LeadRecords {
            store: self.clone(),
            lead: lead_session.to_owned(),
        })
    }

    /// Scout reports for one project, as a backend for the swarm.
    pub fn findings_for(&self, project: &str) -> Arc<dyn Backend> {
        Arc::new(ProjectFindings {
            store: self.clone(),
            project: project.to_owned(),
        })
    }
}

/// FNV-1a: a stable id from a string (unlike `DefaultHasher`, it never changes between Rust versions).
fn fnv(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[derive(Serialize, Deserialize)]
struct FindingDoc {
    project: String,
    worker: String,
    key: String,
    files: Vec<(String, Option<u64>, u64)>,
    handoff: String,
}

struct ProjectFindings {
    store: Store,
    project: String,
}
impl Backend for ProjectFindings {
    fn load(&self) -> Vec<Saved> {
        let prefix = format!("{}:", fnv(&self.project));
        let options = ScanOptions {
            prefix: Some(prefix),
            ..Default::default()
        };
        self.store
            .db
            .col_scan(FINDINGS, &options)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| serde_json::from_value::<FindingDoc>(e.doc).ok())
            .map(|d| Saved {
                worker: d.worker,
                key: d.key,
                files: d.files,
                handoff: d.handoff,
            })
            .collect()
    }
    fn save(&self, report: &Saved) {
        let id = format!(
            "{}:{}",
            fnv(&self.project),
            fnv(&format!("{}\n{}", report.worker, report.key))
        );
        let doc = FindingDoc {
            project: self.project.clone(),
            worker: report.worker.clone(),
            key: report.key.clone(),
            files: report.files.clone(),
            handoff: report.handoff.clone(),
        };
        // A report that cannot be saved is only not reused next time.
        let _ = self.store.put(FINDINGS, &id, &doc);
    }
}

struct LeadRecords {
    store: Store,
    lead: String,
}
impl RecordsBackend for LeadRecords {
    fn load(&self) -> Vec<SavedRecord> {
        let options = ScanOptions {
            prefix: Some(format!("{}:", self.lead)),
            ..Default::default()
        };
        let mut records: Vec<SavedRecord> = self
            .store
            .db
            .col_scan(DELEGATIONS, &options)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| serde_json::from_value(e.doc).ok())
            .collect();
        // Their ids are D1, D2, ... D10: numeric order, so new ids continue the sequence.
        records.sort_by_key(|r| {
            r.id.trim_start_matches('D')
                .parse::<u64>()
                .unwrap_or(u64::MAX)
        });
        records
    }
    fn save(&self, record: &SavedRecord) {
        let _ = self
            .store
            .put(DELEGATIONS, &format!("{}:{}", self.lead, record.id), record);
    }
}
