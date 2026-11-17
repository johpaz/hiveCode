//! The swarm: a lead (BEE) that delegates bounded tasks to profiled workers.
//!
//! `Swarm` is a [`ToolSet`] given to the lead. `task_delegate` runs one worker; `task_delegate_group`
//! runs several at once. (The SDK engine executes a model's tool calls one at a time, so parallel
//! work is expressed as one group call, the same way the SDK gateway does it; the TS version ran
//! several `task_delegate` calls of one step together.) Inside a group a task can wait for others
//! with `after: [ref]` and receives their handoffs; if one fails, its dependents are not started
//! and come back `blocked_by`.
//!
//! Workers run in their own sessions with their profile's tools only and cannot delegate. A writing
//! profile used twice at once needs instances (`builder`, `builder#2`, `builder#3`): each extra
//! instance works in a private git worktree and its changes are merged back into the lead's
//! worktree when it finishes. A conflict leaves the private copy for inspection.
pub mod board;
pub mod findings;
pub mod profiles;
pub mod records;
pub mod specialties;

use futures_util::future::join_all;
use hive_agent_core::{Tool, provider::CancellationToken};
use hivecode_host::{BoxFuture, Budget, Event, Host, HostConfig, Mode, Result, Store, ToolSet};
use hivecode_workspace::{Assignment, Integration, Workspaces};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

const MAX_TASKS: usize = 16;
const MAX_DESCRIPTION: usize = 20_000;
const MAX_CONTEXT: usize = 8_000;
const MAX_HANDOFF_CHARS: usize = 12_000;
const MAX_DEP_CHARS: usize = 3_000;

pub type ToolsFor = Arc<dyn Fn(&Path) -> Vec<Arc<dyn ToolSet>> + Send + Sync>;
pub type Approver = Arc<dyn Fn(&str, &Value) -> bool + Send + Sync>;
pub type Observer = Arc<dyn Fn(&str, &Event) + Send + Sync>;

/// What happens between the lead and its workers, for a UI that draws the team (a delegation is a
/// line from the lead to the worker; its end is a handoff, or a failure).
#[derive(Clone, Debug, PartialEq)]
pub enum SwarmEvent {
    Delegated {
        id: String,
        from: String,
        to: String,
        summary: String,
    },
    Finished {
        id: String,
        from: String,
        to: String,
        ok: bool,
        summary: String,
    },
    /// A worker that cannot start until the tasks it depends on finish.
    Waiting {
        worker: String,
        for_refs: Vec<String>,
        reason: &'static str,
    },
}
pub type Lifecycle = Arc<dyn Fn(&SwarmEvent) + Send + Sync>;

pub struct SwarmConfig {
    pub store: Store,
    /// The run's shared budget; workers draw from it one level below the lead.
    pub budget: Option<Budget>,
    pub provider: Value,
    pub model: String,
    pub context_window: Option<u64>,
    pub max_tool_calls: u32,
    pub web: Option<Value>,
    pub allowed_programs: Vec<String>,
    pub mode: Mode,
    /// Session of the lead; worker sessions are derived from it.
    pub session: String,
    /// The lead's worktree: where workers work and where private copies merge back.
    pub root: PathBuf,
    pub workspaces: Workspaces,
    /// The tool sets (git, verify, index, MCP, ...) for a given root.
    pub tools_for: ToolsFor,
    /// Asked before a worker runs a mutating tool in `approval` mode.
    pub approve: Approver,
    /// Told what every worker does, by instance name.
    pub observe: Option<Observer>,
    /// Told when a worker is delegated to, waits, and finishes.
    pub lifecycle: Option<Lifecycle>,
    /// Where scout reports are kept between runs. None keeps them for this process only.
    pub findings: Option<Arc<dyn findings::Backend>>,
    /// Where delegations are kept, so a resumed run can still `task_revise` them.
    pub records: Option<Arc<dyn records::Backend>>,
}

/// A delegation that can be revised: the worker's own session stays, so it keeps its context.
#[derive(Clone)]
struct Record {
    id: String,
    reference: String,
    worker: String,
    session: String,
    runs: u32,
    ok: bool,
    /// A private copy that could not be merged and was kept for inspection.
    kept: Option<Assignment>,
}

impl Record {
    fn to_saved(&self) -> records::SavedRecord {
        records::SavedRecord {
            id: self.id.clone(),
            reference: self.reference.clone(),
            worker: self.worker.clone(),
            session: self.session.clone(),
            runs: self.runs,
            ok: self.ok,
            kept: self.kept.as_ref().map(|a| records::SavedCopy {
                workspace_id: a.workspace_id.clone(),
                task_id: a.task_id.clone(),
                project: a.project.display().to_string(),
                worktree: a.worktree.display().to_string(),
                branch: a.branch.clone(),
                baseline_ref: a.baseline_ref.clone(),
            }),
        }
    }
    fn from_saved(saved: records::SavedRecord) -> Self {
        Self {
            id: saved.id,
            reference: saved.reference,
            worker: saved.worker,
            session: saved.session,
            runs: saved.runs,
            ok: saved.ok,
            // A copy that is gone cannot be revised in place: the revision prepares a new one.
            kept: saved
                .kept
                .filter(|c| Path::new(&c.worktree).is_dir())
                .map(|c| Assignment {
                    workspace_id: c.workspace_id,
                    task_id: c.task_id,
                    project: c.project.into(),
                    worktree: c.worktree.into(),
                    branch: c.branch,
                    baseline_ref: c.baseline_ref,
                    isolated: true,
                }),
        }
    }
}

pub struct Swarm {
    cfg: SwarmConfig,
    runs: AtomicU32,
    delegations: AtomicU32,
    records: Mutex<Vec<Record>>,
    board: Arc<board::Board>,
    findings: findings::Findings,
    /// Prompts to the person one at a time.
    asking: Arc<Mutex<()>>,
}

struct Task {
    reference: String,
    worker: String,
    description: String,
    context: String,
    after: Vec<String>,
    /// Run even if a saved report already covers the question.
    refresh: bool,
    /// A specialty asked for (`security`, `verifier/security`); chosen from the task when absent.
    specialty: Option<String>,
}

#[derive(Clone)]
struct Outcome {
    ok: bool,
    value: Value,
    handoff: String,
}

impl Swarm {
    pub fn new(cfg: SwarmConfig) -> Self {
        let findings = cfg.findings.clone().map_or_else(
            findings::Findings::default,
            findings::Findings::with_backend,
        );
        let loaded: Vec<Record> = cfg
            .records
            .as_ref()
            .map(|b| b.load().into_iter().map(Record::from_saved).collect())
            .unwrap_or_default();
        Self {
            cfg,
            runs: AtomicU32::new(0),
            delegations: AtomicU32::new(0),
            records: Mutex::new(loaded),
            board: Arc::default(),
            findings,
            asking: Arc::default(),
        }
    }

    /// Runs one task and tells the lifecycle observer about its beginning and its end.
    async fn run_one(
        &self,
        task: &Task,
        deps: &str,
        cancel: &CancellationToken,
        revise: Option<Record>,
    ) -> Outcome {
        let known = profiles::parse_instance(&task.worker)
            .and_then(|(base, _)| profiles::find(base))
            .is_some_and(|p| p.id != profiles::LEAD);
        let Some(observer) = self.cfg.lifecycle.clone().filter(|_| known) else {
            return self.run_one_inner(task, deps, cancel, revise).await;
        };
        let id = format!("d{}", self.delegations.fetch_add(1, Ordering::SeqCst) + 1);
        let summary: String = task.description.chars().take(160).collect();
        observer(&SwarmEvent::Delegated {
            id: id.clone(),
            from: profiles::LEAD.into(),
            to: task.worker.clone(),
            summary,
        });
        let outcome = self.run_one_inner(task, deps, cancel, revise).await;
        let what = outcome.value["error"].as_str().unwrap_or(&outcome.handoff);
        observer(&SwarmEvent::Finished {
            id,
            from: profiles::LEAD.into(),
            to: task.worker.clone(),
            ok: outcome.ok,
            summary: what.chars().take(160).collect(),
        });
        outcome
    }

    async fn run_one_inner(
        &self,
        task: &Task,
        deps: &str,
        cancel: &CancellationToken,
        revise: Option<Record>,
    ) -> Outcome {
        let fail = |error: String| Outcome {
            ok: false,
            handoff: error.clone(),
            value: json!({"ok": false, "ref": task.reference, "worker_id": task.worker, "error": error}),
        };
        let Some((base, number)) = profiles::parse_instance(&task.worker) else {
            return fail(format!(
                "worker `{}`: an instance is written builder#2 or builder#3 (at most {})",
                task.worker,
                profiles::MAX_INSTANCES
            ));
        };
        let Some(profile) = profiles::find(base).filter(|p| p.id != profiles::LEAD) else {
            let known: Vec<_> = profiles::all()
                .iter()
                .map(|p| p.id)
                .filter(|id| *id != profiles::LEAD)
                .collect();
            return fail(format!(
                "worker not found: {base} (available: {})",
                known.join(", ")
            ));
        };

        // Extra instructions for this kind of work. A revision keeps the ones it already had: they are in
        // the worker's own conversation.
        let specialty = if revise.is_some() {
            None
        } else {
            match specialties::select(profile.id, &task.description, task.specialty.as_deref()) {
                Ok(chosen) => chosen,
                Err(error) => return fail(error),
            }
        };

        // A reader asked the same question over files that have not changed: the saved report is the
        // answer, and no model is called.
        let reader = profile.id == "scout" && revise.is_none();
        let key = findings::Findings::key(&task.description, &task.context);
        let named = if reader {
            findings::files_named(
                &self.cfg.root,
                &format!("{}\n{}", task.description, task.context),
            )
        } else {
            vec![]
        };
        if reader
            && !task.refresh
            && let Some(saved) = self.findings.lookup(&task.worker, &key, &self.cfg.root)
        {
            return Outcome {
                ok: true,
                handoff: saved.clone(),
                value: json!({"ok": true, "reused": true, "ref": task.reference, "worker_id": task.worker,
                    "result": format!("[Informe guardado reutilizado: los archivos que cubre no han cambiado, así que no se volvió a leer nada. Pasa refresh: true para rehacerlo.]\n{saved}")}),
            };
        }
        let before = findings::fingerprint(&self.cfg.root, &named);

        // A second instance of a writing profile works on its own copy of the lead's worktree.
        // A revision whose copy was kept (it could not be merged) works in that same copy.
        let reused = revise.as_ref().and_then(|r| r.kept.clone());
        let private = reused.clone().or_else(|| {
            (profile.writes && number >= 2).then(|| {
                self.cfg.workspaces.swarm_assignment(
                    &self.cfg.session,
                    &task.worker,
                    &self.cfg.root,
                )
            })
        });
        let root = match &private {
            Some(assignment) => {
                if reused.is_none()
                    && let Err(e) = self.cfg.workspaces.prepare(assignment, "HEAD").await
                {
                    return fail(format!("could not prepare a private copy: {e}"));
                }
                assignment.worktree.clone()
            }
            None => self.cfg.root.clone(),
        };

        let agent = task.worker.replace('#', "-");
        let number_of_run = self.runs.fetch_add(1, Ordering::SeqCst);
        // A revision resumes the worker's own session, so it keeps what it already knows.
        let session = match &revise {
            Some(record) => record.session.clone(),
            None => format!("{}-{agent}-{number_of_run}", self.cfg.session),
        };
        let host = match Host::open(HostConfig {
            db: PathBuf::new(),
            store: Some(self.cfg.store.clone()),
            budget: self.cfg.budget.as_ref().map(|b| Budget {
                objective_id: b.objective_id.clone(),
                depth: 1,
            }),
            root: root.clone(),
            provider: self.cfg.provider.clone(),
            model: self.cfg.model.clone(),
            system: Some(profile.prompt.to_owned()),
            agent: agent.clone(),
            session: session.clone(),
            max_turns: 24,
            allowed_programs: self.cfg.allowed_programs.clone(),
            mode: self.cfg.mode,
            context_window: self.cfg.context_window,
            max_tool_calls: self.cfg.max_tool_calls,
            web: self.cfg.web.clone(),
            extra_tools: {
                let mut sets = (self.cfg.tools_for)(&root);
                sets.push(Arc::new(WaitFor {
                    board: self.board.clone(),
                }));
                sets
            },
            allowed_tools: Some(profile.tools.iter().map(|t| t.to_string()).collect()),
        }) {
            Ok(host) => host,
            Err(e) => return fail(format!("could not start the worker: {e}")),
        };

        let mut prompt = if revise.is_some() {
            format!(
                "Revisión pedida por el coordinador sobre tu entrega anterior (conserva lo que ya está bien):\n{}",
                task.description
            )
        } else {
            task.description.clone()
        };
        if let Some(spec) = specialty {
            prompt.push_str(&format!("\n\n{}", specialties::brief(spec)));
        }
        if !task.context.is_empty() {
            prompt.push_str(&format!(
                "\n\nContexto que ya tiene el coordinador (úsalo antes de explorar):\n{}",
                task.context
            ));
        }
        if !deps.is_empty() {
            prompt.push_str(&format!(
                "\n\nEntregas de las tareas de las que depende esta (ya terminadas; construye sobre ellas):\n{deps}"
            ));
        }

        let mut calls = 0u32;
        let observe = self.cfg.observe.clone();
        let approve = self.cfg.approve.clone();
        let asking = self.asking.clone();
        let who = task.worker.clone();
        let result = host
            .run(
                &prompt,
                &mut |event| {
                    if matches!(event, Event::ToolDone { .. } | Event::ToolDenied { .. }) {
                        calls += 1;
                    }
                    if let Some(observe) = &observe {
                        observe(&who, &event);
                    }
                },
                &mut |name, arguments| {
                    let _one_at_a_time = asking.lock().unwrap_or_else(|e| e.into_inner());
                    approve(name, arguments)
                },
                cancel,
            )
            .await;

        let (mut merge, mut kept, mut kept_copy) = (None, None, None);
        if let Some(assignment) = &private {
            let outcome = self.cfg.workspaces.integrate(assignment).await;
            let (label, clean) = match &outcome {
                Integration::Integrated { .. } => ("integrated", true),
                Integration::Noop => ("noop", true),
                Integration::Conflict { .. } => ("conflict", false),
                Integration::Failed { .. } => ("failed", false),
            };
            merge = Some(label);
            // A copy that could not be merged stays, so its work can be inspected.
            if clean {
                let _ = self.cfg.workspaces.cleanup(assignment).await;
            } else {
                kept = Some(assignment.worktree.display().to_string());
                kept_copy = Some(assignment.clone());
            }
        }

        let finished = result.is_ok() && merge.is_none_or(|m| m == "integrated" || m == "noop");
        let task_id = self.remember(task, &session, revise.as_ref(), finished, kept_copy);
        match result {
            Ok(text) => {
                let handoff: String = text.chars().take(MAX_HANDOFF_CHARS).collect();
                if reader {
                    self.findings.store(&task.worker, &key, before, &handoff);
                }
                let mut value = json!({"ok": true, "task_id": task_id, "ref": task.reference,
                    "worker_id": task.worker, "tool_calls": calls, "result": handoff});
                if let Some(spec) = specialty {
                    value["specialty"] = json!(spec.id);
                }
                if let Some(merge) = merge {
                    value["merge"] = json!(merge);
                }
                if let Some(path) = kept {
                    value["workspace"] = json!(path);
                }
                Outcome {
                    ok: merge.is_none_or(|m| m == "integrated" || m == "noop"),
                    value,
                    handoff,
                }
            }
            Err(e) => {
                let mut outcome = fail(format!("the worker did not finish: {e}"));
                outcome.value["task_id"] = json!(task_id);
                outcome
            }
        }
    }

    /// Keeps (or updates) what is needed to revise this delegation later; returns its `task_id`.
    fn remember(
        &self,
        task: &Task,
        session: &str,
        revise: Option<&Record>,
        ok: bool,
        kept: Option<Assignment>,
    ) -> String {
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(previous) = revise
            && let Some(record) = records.iter_mut().find(|r| r.id == previous.id)
        {
            record.runs += 1;
            record.ok = ok;
            record.kept = kept;
            if let Some(backend) = &self.cfg.records {
                backend.save(&record.to_saved());
            }
            return record.id.clone();
        }
        let id = format!("D{}", records.len() + 1);
        let record = Record {
            id: id.clone(),
            reference: task.reference.clone(),
            worker: task.worker.clone(),
            session: session.to_owned(),
            runs: 1,
            ok,
            kept,
        };
        if let Some(backend) = &self.cfg.records {
            backend.save(&record.to_saved());
        }
        records.push(record);
        id
    }

    fn find_record(&self, wanted: &str) -> Option<Record> {
        let records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        records
            .iter()
            .rev()
            .find(|r| r.id == wanted || r.reference == wanted)
            .cloned()
    }

    /// Runs the tasks respecting `after`: each wave starts every task whose dependencies are done.
    async fn run_group(&self, tasks: Vec<Task>, cancel: &CancellationToken) -> Vec<Value> {
        // Siblings that run at the same time can wait for each other's handoff.
        for task in &tasks {
            self.board.announce(&task.reference);
            if !task.after.is_empty()
                && let Some(observer) = &self.cfg.lifecycle
            {
                observer(&SwarmEvent::Waiting {
                    worker: task.worker.clone(),
                    for_refs: task.after.clone(),
                    reason: "dependencia",
                });
            }
        }
        let mut done: HashMap<String, Outcome> = HashMap::new();
        let mut pending: Vec<&Task> = tasks.iter().collect();
        let mut order: Vec<String> = vec![];
        let mut blocked: HashMap<String, Vec<String>> = HashMap::new();
        loop {
            let (ready, rest): (Vec<&Task>, Vec<&Task>) = pending
                .into_iter()
                .partition(|t| t.after.iter().all(|d| done.get(d).is_some_and(|o| o.ok)));
            // Anything that depends on a task that failed can never start.
            let (dead, waiting): (Vec<&Task>, Vec<&Task>) = rest
                .into_iter()
                .partition(|t| t.after.iter().any(|d| done.get(d).is_some_and(|o| !o.ok)));
            for task in dead {
                let why: Vec<String> = task
                    .after
                    .iter()
                    .filter(|d| done.get(*d).is_some_and(|o| !o.ok))
                    .cloned()
                    .collect();
                done.insert(
                    task.reference.clone(),
                    Outcome {
                        ok: false,
                        handoff: String::new(),
                        value: json!({"ok": false, "ref": task.reference, "worker_id": task.worker,
                            "error": format!("Dependency not met: {} did not complete", why.join(", ")),
                            "blocked_by": why}),
                    },
                );
                self.board.settle(&task.reference, false, "");
                blocked.insert(task.reference.clone(), why);
                order.push(task.reference.clone());
            }
            pending = waiting;
            if ready.is_empty() {
                break;
            }
            let results = join_all(ready.iter().map(|task| {
                let deps = task
                    .after
                    .iter()
                    .map(|d| {
                        let text: String = done[d].handoff.chars().take(MAX_DEP_CHARS).collect();
                        format!("### {d}\n{text}")
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                async move {
                    let outcome = self.run_one(task, &deps, cancel, None).await;
                    self.board
                        .settle(&task.reference, outcome.ok, &outcome.handoff);
                    outcome
                }
            }))
            .await;
            for (task, outcome) in ready.iter().zip(results) {
                order.push(task.reference.clone());
                done.insert(task.reference.clone(), outcome);
            }
            if pending.is_empty() {
                break;
            }
        }
        order
            .iter()
            .filter_map(|r| done.get(r).map(|o| o.value.clone()))
            .collect()
    }
}

fn parse_task(raw: &Value, index: usize) -> std::result::Result<Task, String> {
    let text = |key: &str| raw[key].as_str().map(str::trim).filter(|v| !v.is_empty());
    let worker = text("worker_id")
        .ok_or("every task needs a worker_id")?
        .to_owned();
    let description = text("task_description").ok_or("every task needs a task_description")?;
    if description.chars().count() > MAX_DESCRIPTION {
        return Err(format!(
            "task_description is longer than {MAX_DESCRIPTION} characters"
        ));
    }
    let context = text("context").unwrap_or_default();
    if context.chars().count() > MAX_CONTEXT {
        return Err(format!(
            "context is longer than {MAX_CONTEXT} characters: pass paths with line ranges, not the text of the files"
        ));
    }
    Ok(Task {
        reference: text("ref").map_or_else(|| format!("T{}", index + 1), str::to_owned),
        worker,
        description: description.to_owned(),
        context: context.to_owned(),
        after: raw["after"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        refresh: raw["refresh"] == true,
        specialty: text("specialty").map(str::to_owned),
    })
}

/// Checks a group before anything runs: refs unique and known, no cycles, and no two tasks sharing a
/// writing worker without instances.
fn validate(tasks: &[Task]) -> std::result::Result<(), String> {
    let mut refs = HashSet::new();
    for task in tasks {
        if !refs.insert(task.reference.as_str()) {
            return Err(format!("ref `{}` is used twice", task.reference));
        }
    }
    for task in tasks {
        for dep in &task.after {
            if !refs.contains(dep.as_str()) {
                return Err(format!(
                    "`{}` waits for `{dep}`, which is not in this group",
                    task.reference
                ));
            }
            if *dep == task.reference {
                return Err(format!("`{}` cannot wait for itself", task.reference));
            }
        }
    }
    // A cycle never becomes ready: simulate the waves.
    let mut done: HashSet<&str> = HashSet::new();
    while done.len() < tasks.len() {
        let ready: Vec<&Task> = tasks
            .iter()
            .filter(|t| {
                !done.contains(t.reference.as_str())
                    && t.after.iter().all(|d| done.contains(d.as_str()))
            })
            .collect();
        if ready.is_empty() {
            return Err("the `after` dependencies form a cycle".into());
        }
        done.extend(ready.iter().map(|t| t.reference.as_str()));
    }
    let mut writers = HashSet::new();
    for task in tasks {
        if let Some((base, _)) = profiles::parse_instance(&task.worker)
            && profiles::find(base).is_some_and(|p| p.writes)
            && !writers.insert(task.worker.as_str())
        {
            return Err(format!(
                "two tasks use `{}`: give the second its own instance ({}#2, {}#3)",
                task.worker, base, base
            ));
        }
    }
    Ok(())
}

fn task_schema() -> Value {
    json!({"type":"object","properties":{
        "worker_id":{"type":"string","maxLength":40,"description":"scout, builder, verifier or spider. To run the same writing profile twice at once use an instance: builder#2, builder#3 — each gets its own copy of the workspace and its work is merged back when it finishes."},
        "task_description":{"type":"string","minLength":1,"maxLength":MAX_DESCRIPTION,"description":"Clear, detailed instructions, with acceptance criteria."},
        "context":{"type":"string","maxLength":MAX_CONTEXT,"description":"Evidence you already hold that the worker needs (paths with line ranges, symbols, findings): it reads those lines instead of walking the repo."},
        "ref":{"type":"string","maxLength":40,"description":"A label for this task in your plan, so others can wait for it with after."},
        "specialty":{"type":"string","maxLength":40,"description":"Optional: a specialty of the worker (builder: backend, frontend, data, devops, integration; verifier: security, acceptance; scout: repository; spider: web). Chosen from the task when omitted."},
        "refresh":{"type":"boolean","description":"Run the scout even if a saved report already covers the same question over files that have not changed."},
        "after":{"type":"array","items":{"type":"string","maxLength":40},"maxItems":16,"description":"Refs in this group this task depends on. It does not start until they finish and receives their handoffs; if one fails you get blocked_by back."}
    },"required":["worker_id","task_description"],"additionalProperties":false})
}

impl ToolSet for Swarm {
    fn definitions(&self) -> Vec<Tool> {
        vec![
            Tool {
                name: "task_delegate".into(),
                description: "Delegate one bounded task to a worker and get its handoff. You are the fan-in: judge the evidence it returns.".into(),
                parameters: {
                    let mut schema = task_schema();
                    schema["properties"].as_object_mut().map(|p| p.remove("after"));
                    schema
                },
                allow_repeated_results: false,
            },
            Tool {
                name: "task_revise".into(),
                description: "Send a delegated task back to the same worker with feedback. The worker keeps its own context (it remembers what it read and did), so tell it only what is missing or wrong. Use it instead of delegating again.".into(),
                parameters: json!({"type":"object","properties":{
                    "task_id":{"type":"string","maxLength":40,"description":"The task_id (D1, D2...) or the ref of the delegation."},
                    "feedback":{"type":"string","minLength":1,"maxLength":MAX_DESCRIPTION,"description":"What is missing or wrong, and what you expect now."}
                },"required":["task_id","feedback"],"additionalProperties":false}),
                allow_repeated_results: false,
            },
            Tool {
                name: "task_status".into(),
                description: "List the tasks delegated so far: id, ref, worker, how many times it ran and whether its last run was accepted.".into(),
                parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
                allow_repeated_results: true,
            },
            Tool {
                name: "task_delegate_group".into(),
                description: "Delegate several bounded tasks at once; they run in parallel. A task can wait for others with `after`. Returns one result per task.".into(),
                parameters: json!({"type":"object","properties":{
                    "tasks":{"type":"array","minItems":1,"maxItems":MAX_TASKS,"items":task_schema()}
                },"required":["tasks"],"additionalProperties":false}),
                allow_repeated_results: false,
            },
        ]
    }

    /// Delegating is orchestration; each worker applies the mode to its own tools.
    fn mutates(&self, _: &str, _: &Value) -> bool {
        false
    }

    fn execute<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            if name == "task_status" {
                let records = self.records.lock().unwrap_or_else(|e| e.into_inner());
                let rows: Vec<Value> = records
                    .iter()
                    .map(|r| {
                        let mut row = json!({"task_id": r.id, "ref": r.reference,
                            "worker_id": r.worker, "runs": r.runs, "ok": r.ok});
                        if let Some(copy) = &r.kept {
                            row["workspace"] = json!(copy.worktree.display().to_string());
                        }
                        row
                    })
                    .collect();
                return Ok(json!({"ok": true, "tasks": rows}));
            }
            if name == "task_revise" {
                let wanted = arguments["task_id"].as_str().unwrap_or_default();
                let feedback = arguments["feedback"]
                    .as_str()
                    .map(str::trim)
                    .unwrap_or_default();
                if feedback.is_empty() || feedback.chars().count() > MAX_DESCRIPTION {
                    return Ok(
                        json!({"ok": false, "error": "feedback is required (and at most 20000 characters)"}),
                    );
                }
                let Some(record) = self.find_record(wanted) else {
                    return Ok(
                        json!({"ok": false, "error": format!("no delegated task `{wanted}`; task_status lists them")}),
                    );
                };
                let task = Task {
                    reference: record.reference.clone(),
                    worker: record.worker.clone(),
                    description: feedback.to_owned(),
                    context: String::new(),
                    after: vec![],
                    refresh: false,
                    specialty: None,
                };
                return Ok(self.run_one(&task, "", cancel, Some(record)).await.value);
            }
            let raw: Vec<Value> = if name == "task_delegate" {
                vec![arguments]
            } else {
                arguments["tasks"].as_array().cloned().unwrap_or_default()
            };
            let tasks: std::result::Result<Vec<Task>, String> = raw
                .iter()
                .enumerate()
                .map(|(i, t)| parse_task(t, i))
                .collect();
            let tasks = match tasks.and_then(|t| validate(&t).map(|()| t)) {
                Ok(tasks) if !tasks.is_empty() => tasks,
                Ok(_) => return Ok(json!({"ok": false, "error": "no tasks"})),
                Err(error) => return Ok(json!({"ok": false, "error": error})),
            };
            let results = self.run_group(tasks, cancel).await;
            if name == "task_delegate" {
                return Ok(results.into_iter().next().unwrap_or(Value::Null));
            }
            let all = results.iter().all(|r| r["ok"] == true);
            Ok(json!({"ok": all, "results": results}))
        })
    }
}

/// `wait_for`: a worker waits for the handoff of a task running at the same time, instead of
/// polling with `sleep`. Costs no tokens while it waits.
struct WaitFor {
    board: Arc<board::Board>,
}
const MAX_WAIT_MS: u64 = 900_000;
const DEFAULT_WAIT_MS: u64 = 300_000;

impl ToolSet for WaitFor {
    fn definitions(&self) -> Vec<Tool> {
        vec![Tool {
            name: "wait_for".into(),
            description: "Wait for another delegated task (by its ref) to finish and get its handoff. Use it instead of polling with sleep. It fails after the timeout if that task never finishes.".into(),
            parameters: json!({"type":"object","properties":{
                "ref":{"type":"string","maxLength":40,"description":"The ref of the task to wait for."},
                "timeout_ms":{"type":"integer","minimum":1000,"maximum":MAX_WAIT_MS}
            },"required":["ref"],"additionalProperties":false}),
            allow_repeated_results: true,
        }]
    }
    fn mutates(&self, _: &str, _: &Value) -> bool {
        false
    }
    fn execute<'a>(
        &'a self,
        _: &'a str,
        arguments: Value,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let reference = arguments["ref"].as_str().unwrap_or_default();
            let timeout = arguments["timeout_ms"]
                .as_u64()
                .unwrap_or(DEFAULT_WAIT_MS)
                .min(MAX_WAIT_MS);
            Ok(
                match self
                    .board
                    .wait(reference, std::time::Duration::from_millis(timeout), cancel)
                    .await
                {
                    Ok(settled) => {
                        let text: String = settled.handoff.chars().take(MAX_DEP_CHARS).collect();
                        json!({"ok": settled.ok, "ref": reference,
                        "status": if settled.ok { "completed" } else { "failed" }, "result": text})
                    }
                    Err(board::WaitError::Unknown) => json!({"ok": false, "error":
                    format!("`{reference}` was never delegated (delegate it first or in the same group)")}),
                    Err(board::WaitError::Timeout) => json!({"ok": false, "error":
                    format!("`{reference}` did not finish in time")}),
                    Err(board::WaitError::Cancelled) => return Err("cancelled".into()),
                },
            )
        })
    }
}
