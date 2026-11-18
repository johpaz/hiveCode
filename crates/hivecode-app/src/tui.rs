//! `hivecode` with no arguments: the terminal UI.
//!
//! The TUI (`packages/hivetui`, Rust) is a separate program that talks NDJSON over a local socket,
//! exactly as it did with the TS process. This module is the server side of that protocol, for the
//! messages a run needs: it launches the TUI, tells it the session (`init`), runs each submitted task
//! through [`crate::run`] with a [`TuiUi`] that turns what the run does into protocol messages, and
//! carries the person's answers to approval requests back. Each task after the first resumes the
//! previous run, so the lead keeps the conversation.
use crate::{Args, Report, Ui, home};
use hivecode_host::{CancellationToken, Event, Mode};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    sync::mpsc::{UnboundedSender, unbounded_channel},
};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The protocol, one run at a time: what a run does, as messages for the TUI.
pub struct TuiUi {
    out: UnboundedSender<String>,
    seq: AtomicU64,
    next_call: AtomicU64,
    next_request: AtomicU64,
    /// Calls that started and have not finished, per `worker|tool`, oldest first.
    calls: Mutex<HashMap<String, VecDeque<(String, Instant)>>>,
    approvals: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    last_run: Mutex<Option<String>>,
    /// The last run ended in `plan` mode with a plan nobody has approved yet.
    plan_ready: std::sync::atomic::AtomicBool,
}

impl TuiUi {
    pub fn new(out: UnboundedSender<String>) -> Self {
        Self {
            out,
            seq: AtomicU64::new(0),
            next_call: AtomicU64::new(0),
            next_request: AtomicU64::new(0),
            calls: Mutex::default(),
            approvals: Mutex::default(),
            last_run: Mutex::default(),
            plan_ready: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn send(&self, priority: &str, kind: &str, payload: Value) {
        let line = json!({"protocol_version": 1, "priority": priority,
            "seq": self.seq.fetch_add(1, Ordering::SeqCst) + 1, "type": kind, "payload": payload});
        let _ = self.out.send(line.to_string());
    }

    pub fn init(&self, session: &str, mode: Mode, provider: &str, model: &str, project: &str) {
        let name = std::path::Path::new(project)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.send(
            "critical",
            "init",
            json!({
                "session_id": session, "workers": ["bee", "scout", "builder", "verifier", "spider"],
                "mode": mode.as_str(), "provider": provider, "model": model,
                "project_name": name, "project_path": project, "version": env!("CARGO_PKG_VERSION"),
            }),
        );
    }
    pub fn settings(&self, data: Value) {
        self.send("normal", "settings_data", data);
    }
    pub fn config_modal(&self, command: &str, title: &str, fields: Vec<Value>) {
        self.send(
            "normal",
            "show_config_modal",
            json!({"command": command, "title": title, "fields": fields}),
        );
    }
    pub fn info_modal(&self, title: &str, content: &str) {
        self.send(
            "normal",
            "show_info_modal",
            json!({"title": title, "content": content}),
        );
    }
    /// A run the person can undo, as a restore point the TUI lists.
    pub fn checkpoint(&self, id: &str, description: &str, files: usize) {
        self.send(
            "low",
            "checkpoint_created",
            json!({"checkpoint_id": id, "description": description,
            "file_count": files, "agent": "bee"}),
        );
    }
    /// A run that was cut: the `▶ RESUME` badge.
    pub fn resumable(&self, id: &str) {
        self.send(
            "low",
            "resume_available",
            json!({"task_id": id, "checkpoint_id": id,
            "reason": "la corrida se interrumpió a mitad de un turno"}),
        );
    }
    pub fn history(&self, role: &str, content: &str) {
        self.send(
            "normal",
            "history_append",
            json!({"role": role, "content": content}),
        );
    }
    pub fn status(&self, running: bool, msg: &str) {
        self.send("normal", "status", json!({"running": running, "msg": msg}));
    }
    pub fn mode(&self, mode: Mode) {
        self.send("normal", "state_update", json!({"new_mode": mode.as_str()}));
    }
    /// Whether the run that just ended produced a plan waiting for approval (and forgets it).
    pub fn take_plan_ready(&self) -> bool {
        self.plan_ready.swap(false, Ordering::SeqCst)
    }
    pub fn last_run(&self) -> Option<String> {
        self.last_run
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    /// The person's answer to an approval request.
    pub fn answer(&self, request_id: &str, approve: bool) {
        if let Some(waiting) = self
            .approvals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(request_id)
        {
            let _ = waiting.send(approve);
        }
    }

    fn ask(&self, agent: &str, tool: &str, summary: &str, detail: &str, kind: &str) -> bool {
        let id = format!(
            "req-{}",
            self.next_request.fetch_add(1, Ordering::SeqCst) + 1
        );
        let (tx, rx) = mpsc::channel();
        self.approvals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), tx);
        self.send("critical", "tool_approval_request", json!({
            "request_id": id, "agent": agent, "tool": tool, "summary": summary, "detail": detail, "kind": kind}));
        // The run is on a runtime worker: say so, so the runtime can use another meanwhile.
        let answer = tokio::task::block_in_place(|| rx.recv().unwrap_or(false));
        self.approvals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        answer
    }
}

/// What a tool does, as the TUI draws it (`reading`, `searching`, `writing`, `executing`).
fn phase_of(tool: &str) -> &'static str {
    match tool {
        "fs_write" | "fs_edit" | "git_commit" => "writing",
        "command_run" | "verify_run" => "executing",
        "fs_grep" | "find_symbol" | "web_search" | "adr_search" => "searching",
        "task_delegate" | "task_delegate_group" | "task_revise" | "wait_for" => "thinking",
        _ => "reading",
    }
}

fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

impl Ui for TuiUi {
    fn note(&self, text: &str) {
        self.history("system", text);
    }

    fn event(&self, worker: Option<&str>, event: &Event) {
        let agent = worker.unwrap_or("bee");
        match event {
            Event::Text(text) => {
                if worker.is_none() {
                    self.send(
                        "normal",
                        "assistant_chunk",
                        json!({"text": text, "agent": agent}),
                    );
                }
            }
            Event::ToolStart { name, arguments } => {
                let id = format!("c{}", self.next_call.fetch_add(1, Ordering::SeqCst) + 1);
                self.calls
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .entry(format!("{agent}|{name}"))
                    .or_default()
                    .push_back((id.clone(), Instant::now()));
                self.send(
                    "normal",
                    "tool_call",
                    json!({"agent": agent, "tool": name, "call_id": id,
                    "args_summary": clip(&arguments.to_string(), 120), "at": now_ms()}),
                );
                self.send(
                    "normal",
                    "worker_update",
                    json!({"worker": agent, "parent_id": worker.map(|_| "bee"),
                        "phase": phase_of(name), "status": "running", "display_name": agent,
                        "activity": name, "current_action": name}),
                );
            }
            Event::ToolDone { name, ok } => self.finish(agent, name, *ok, ""),
            Event::ToolDenied { name, reason } => self.finish(agent, name, false, reason),
        }
    }

    fn approve(&self, name: &str, arguments: &Value) -> bool {
        self.ask(
            "bee",
            name,
            &format!("BEE quiere ejecutar {name}"),
            &clip(
                &serde_json::to_string_pretty(arguments).unwrap_or_default(),
                3000,
            ),
            "tool",
        )
    }

    fn gate(&self, gate: &str, text: &str) -> bool {
        self.ask(
            "bee",
            gate,
            "Aprobar el resultado",
            &clip(text, 6000),
            "gate",
        )
    }

    fn swarm(&self, event: &hivecode_swarm::SwarmEvent) {
        use hivecode_swarm::SwarmEvent::*;
        match event {
            Delegated {
                id,
                from,
                to,
                summary,
            } => {
                self.send("normal", "swarm_collaboration", json!({"event_id": format!("{id}:start"), "delegation_id": id,
                    "from": from, "to": to, "kind": "delegation", "summary": summary, "at": now_ms()}));
                self.send(
                    "normal",
                    "worker_update",
                    json!({"worker": to, "parent_id": from, "phase": "thinking",
                    "status": "running", "display_name": to, "activity": summary}),
                );
            }
            Finished {
                id,
                from,
                to,
                ok,
                summary,
            } => {
                self.send("normal", "swarm_collaboration", json!({"event_id": format!("{id}:end"), "delegation_id": id,
                    "from": from, "to": to, "kind": if *ok { "handoff" } else { "failed" }, "summary": summary, "at": now_ms()}));
                self.send("normal", "worker_update", json!({"worker": to, "parent_id": from,
                    "phase": if *ok { "done" } else { "error" }, "status": if *ok { "done" } else { "error" },
                    "display_name": to, "activity": summary}));
            }
            Waiting {
                worker,
                for_refs,
                reason,
            } => {
                self.send("normal", "esperando", json!({"agent": worker, "esperando_a": for_refs, "razon": reason, "at": now_ms()}));
            }
        }
    }

    fn done(&self, report: &Report) {
        *self.last_run.lock().unwrap_or_else(|e| e.into_inner()) = Some(report.run_id.clone());
        self.send("normal", "assistant_done", json!({}));
        if report
            .harness
            .as_ref()
            .is_some_and(|h| h["status"] == "ready")
        {
            self.plan_ready.store(true, Ordering::SeqCst);
            self.send("normal", "plan_approval_request", json!({}));
        }
        if report.undoable {
            let first = report.objective.lines().next().unwrap_or_default();
            self.checkpoint(&report.run_id, first, report.changed.len());
        }
        for risk in &report.risks {
            self.send("low", "file_risk_update", json!({"path": risk["path"], "risk": risk["risk"],
                "operation": "modified", "agent": "bee", "adr_ref": risk["adr"], "reason": risk["reason"]}));
        }
        let mut note = format!(
            "Corrida {} · cambios: {}",
            report.run_id, report.integration
        );
        if report.undoable {
            note.push_str(&format!(
                " · se puede deshacer: hivecode rollback {}",
                report.run_id
            ));
        }
        self.history("system", &note);
    }
}

impl TuiUi {
    fn finish(&self, agent: &str, tool: &str, ok: bool, summary: &str) {
        let started = self
            .calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&format!("{agent}|{tool}"))
            .and_then(VecDeque::pop_front);
        let Some((id, since)) = started else { return };
        self.send("normal", "tool_done", json!({"agent": agent, "tool": tool, "call_id": id, "ok": ok,
            "duration_ms": since.elapsed().as_millis() as u64, "result_summary": summary, "at": now_ms()}));
    }
}

include!(concat!(env!("OUT_DIR"), "/embedded_tui.rs"));

/// Writes the embedded TUI to `<dir>/hivetui-<hash>` (once: a file of the right size is kept) and
/// returns its path. The name carries a hash of the bytes, so a newer hivecode never runs an older TUI.
pub(crate) fn extract(bytes: &[u8], dir: &std::path::Path) -> std::io::Result<PathBuf> {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let target = dir.join(format!("hivetui-{hash:016x}"));
    if std::fs::metadata(&target).is_ok_and(|m| m.len() == bytes.len() as u64) {
        return Ok(target);
    }
    std::fs::create_dir_all(dir)?;
    // Written aside and renamed: two hivecodes starting together never see a half-written program.
    let tmp = dir.join(format!(".hivetui-{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, &target)?;
    Ok(target)
}

/// Where the TUI program is: `HIVECODE_TUI_BIN`, the one embedded in this binary, next to this
/// executable, or the dev build.
pub(crate) fn find_tui() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("HIVECODE_TUI_BIN") {
        return Ok(path.into());
    }
    if let Some(bytes) = EMBEDDED {
        return extract(bytes, &home().join("bin"))
            .map_err(|e| format!("no pude extraer la TUI incrustada: {e}"));
    }
    let beside = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("hivetui")));
    let dev = |profile: &str| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../../packages/hivetui/target/{profile}/hivetui"))
    };
    [beside, Some(dev("release")), Some(dev("debug"))]
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .ok_or_else(|| "no encuentro la TUI (hivetui): compílala con `cd packages/hivetui && cargo build --release` o indica HIVECODE_TUI_BIN".to_owned())
}

/// Tells the TUI which runs can be undone and which one was cut, from the history. The database is
/// opened for this moment only (a run opens it for itself).
fn announce_runs(ui: &TuiUi, db: &std::path::Path) {
    let Ok(store) = hivecode_store::Store::open(db) else {
        return;
    };
    let Ok(runs) = store.runs(10) else { return };
    // Oldest first, so the newest ends up on top of the list.
    for run in runs.iter().rev().filter(|r| r.has_patch && !r.rolled_back) {
        let files = store
            .patch(&run.id)
            .ok()
            .flatten()
            .map_or(0, |p| hivecode_adr::files_in_diff(&p.diff).len());
        ui.checkpoint(
            &run.id,
            run.objective.lines().next().unwrap_or_default(),
            files,
        );
    }
    if let Some(cut) = runs.iter().find(|r| r.status == "running") {
        ui.resumable(&cut.id);
    }
}

/// Starts one task. A task that ends in `plan` mode with a plan leaves its objective in `pending`,
/// waiting for the person to approve it (`/approve auto`, `/approve review`) or drop it (`/reject`).
fn start(
    base: &Args,
    ui: &Arc<TuiUi>,
    prompt: String,
    objective: String,
    mode: Mode,
    pending: &Arc<Mutex<Option<String>>>,
    recover: Option<String>,
) -> (tokio::task::JoinHandle<()>, CancellationToken) {
    let mut args = base.clone();
    args.prompt = prompt;
    args.mode = Some(mode);
    args.resume = recover.clone().or_else(|| ui.last_run());
    args.recover = recover.is_some();
    let cancel = CancellationToken::new();
    let (task_ui, task_cancel, task_pending) = (ui.clone(), cancel.clone(), pending.clone());
    let task = tokio::spawn(async move {
        task_ui.status(true, "Trabajando…");
        match crate::run(args, task_ui.clone(), task_cancel).await {
            Ok(()) => {
                if task_ui.take_plan_ready() {
                    *task_pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(objective);
                }
                task_ui.status(false, "Listo");
            }
            Err(error) => {
                task_ui.history("system", &format!("(×ᴗ×) {error}"));
                task_ui.status(false, "Error");
            }
        }
    });
    (task, cancel)
}

pub async fn serve(base: Args) -> hivecode_host::Result<()> {
    let tui = find_tui()?;
    // The socket lives in a directory only its owner can enter, and is itself owner-only: whoever can
    // connect can drive the agent (approve tools, run tasks), so it must not depend on the umask.
    let run_dir = home().join("run");
    std::fs::create_dir_all(&run_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let socket = run_dir.join(format!("ipc-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    }
    let mut child = tokio::process::Command::new(&tui)
        .env("HIVECODE_IPC", &socket)
        .env("HIVECODE_TUI", "1")
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("no pude lanzar la TUI ({}): {e}", tui.display()))?;
    let accepted = tokio::time::timeout(Duration::from_secs(15), listener.accept()).await;
    let (stream, _) = match accepted {
        Ok(Ok(connection)) => connection,
        _ => {
            let _ = std::fs::remove_file(&socket);
            return Err("la TUI no se conectó".into());
        }
    };
    let (reader, mut writer) = stream.into_split();
    let (tx, mut rx) = unbounded_channel::<String>();
    let write_task = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if writer.write_all(line.as_bytes()).await.is_err()
                || writer.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
    });

    let ui = Arc::new(TuiUi::new(tx));
    let settings = crate::tui_settings::Settings::new(home());
    let mut mode = base.mode.unwrap_or_else(crate::saved_mode);
    let project = std::fs::canonicalize(base.root.clone().unwrap_or_else(|| ".".into()))
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let (model, provider_name) = match crate::settings(&base) {
        Ok(s) => (
            s.model,
            base.preset
                .clone()
                .or_else(|| base.provider_name.clone())
                .or_else(|| {
                    hivecode_config::Config::load(&home())
                        .ok()
                        .and_then(|c| c.active)
                })
                .unwrap_or_else(|| "custom".into()),
        ),
        Err(_) => (String::new(), "sin configurar".into()),
    };
    let db = base.db.clone().unwrap_or_else(crate::db_dir);
    let session = format!("tui-{}", std::process::id());
    ui.init(&session, mode, &provider_name, &model, &project);
    // The history, as restore points to undo and a cut run to resume.
    announce_runs(&ui, &db);

    let mut lines = BufReader::new(reader).lines();
    let mut running: Option<(tokio::task::JoinHandle<()>, CancellationToken)> = None;
    let pending: Arc<Mutex<Option<String>>> = Arc::default();
    loop {
        let line = tokio::select! {
            line = lines.next_line() => match line { Ok(Some(line)) => line, _ => break },
            _ = child.wait() => break,
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match message["type"].as_str().unwrap_or_default() {
            "exit" => break,
            "ready" => ui.status(false, "Listo"),
            "request_settings" => ui.settings(settings.data()),
            "rollback" => {
                let id = message["checkpoint_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                if running
                    .as_ref()
                    .is_some_and(|(task, _)| !task.is_finished())
                {
                    ui.history(
                        "system",
                        "Hay una tarea en curso: espera a que termine (o /halt) antes de deshacer.",
                    );
                    continue;
                }
                let outcome = match hivecode_store::Store::open(&db) {
                    Ok(store) => crate::undo_run(&store, &id).await,
                    Err(error) => Err(error),
                };
                match outcome {
                    Ok((project, files)) => {
                        ui.send(
                            "low",
                            "checkpoint_rollback",
                            json!({"checkpoint_id": id, "files_restored": files}),
                        );
                        ui.history("system", &format!("Deshecha la corrida {id} en {project}."));
                    }
                    Err(error) => ui.history("system", &format!("(×ᴗ×) {error}")),
                }
            }
            "task_resume" => {
                let id = message["task_id"].as_str().unwrap_or_default().to_owned();
                if running
                    .as_ref()
                    .is_some_and(|(task, _)| !task.is_finished())
                {
                    ui.history("system", "Ya hay una tarea en curso (/halt la detiene).");
                    continue;
                }
                ui.history("system", &format!("Retomando la corrida {id}…"));
                running = Some(start(
                    &base,
                    &ui,
                    String::new(),
                    String::new(),
                    mode,
                    &pending,
                    Some(id),
                ));
            }
            "provider_activate" => settings.provider_activate(
                &ui,
                message["provider_id"].as_str().unwrap_or_default(),
                message["api_key"].as_str(),
            ),
            "modal_submit" => {
                let values: std::collections::HashMap<String, String> = message["values"]
                    .as_object()
                    .map(|o| {
                        o.iter()
                            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                            .collect()
                    })
                    .unwrap_or_default();
                settings.modal_submit(
                    &ui,
                    message["command"].as_str().unwrap_or_default(),
                    &values,
                );
            }
            "tool_approval_response" => {
                ui.answer(
                    message["request_id"].as_str().unwrap_or_default(),
                    message["approve"] == true,
                );
            }
            "mode_change" => {
                if let Some(new) = message["mode"].as_str().and_then(Mode::parse) {
                    mode = new;
                    let _ = std::fs::write(home().join("execution_mode"), mode.as_str());
                    ui.mode(mode);
                }
            }
            "submit" => {
                let input = message["input"]
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                if input.is_empty() {
                    continue;
                }
                let busy = running
                    .as_ref()
                    .is_some_and(|(task, _)| !task.is_finished());
                // A plan is waiting: approve it, drop it, or the next text is more context for it.
                let waiting = pending.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let lower = input.to_lowercase();
                let approving = lower == "/approve" || lower.starts_with("/approve ");
                let dropping = lower == "/reject"
                    || (waiting.is_some() && matches!(lower.as_str(), "n" | "no"));
                let context = waiting.is_some() && !input.starts_with('/') && !dropping;
                if approving || dropping || context {
                    let Some(objective) = waiting else {
                        ui.history("system", "No hay un plan pendiente.");
                        continue;
                    };
                    if dropping {
                        *pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        ui.history("system", "Plan descartado.");
                        continue;
                    }
                    if busy {
                        ui.history("system", "Ya hay una tarea en curso (/halt la detiene).");
                        continue;
                    }
                    *pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    let (run_mode, prompt) = if context {
                        ui.history("user", &input);
                        (
                            Mode::Auto,
                            format!("{objective}\n\nContexto adicional de la persona: {input}"),
                        )
                    } else if lower.ends_with("review") {
                        (
                            Mode::Approval,
                            format!(
                                "Plan aprobado: ejecútalo, pidiendo permiso para cada cambio.\n\nTarea original:\n{objective}"
                            ),
                        )
                    } else {
                        (
                            Mode::Auto,
                            format!("Plan aprobado: ejecútalo.\n\nTarea original:\n{objective}"),
                        )
                    };
                    running = Some(start(
                        &base, &ui, prompt, objective, run_mode, &pending, None,
                    ));
                    continue;
                }
                if let Some(command) = input.strip_prefix('/') {
                    let mut words = command.split_whitespace();
                    match words.next() {
                        Some("halt" | "stop") => match &running {
                            Some((_, cancel)) if busy => {
                                cancel.cancel();
                                ui.history("system", "Deteniendo la tarea…");
                            }
                            _ => ui.history("system", "No hay una tarea en curso."),
                        },
                        Some("mode") => match words.last().and_then(Mode::parse) {
                            Some(new) => {
                                mode = new;
                                let _ =
                                    std::fs::write(home().join("execution_mode"), mode.as_str());
                                ui.mode(mode);
                            }
                            None => ui.history("system", "Uso: /mode plan|approval|auto"),
                        },
                        Some("exit" | "quit") => break,
                        _ if settings.command(&ui, &input) => {}
                        _ => ui.history(
                            "system",
                            "Comandos: /mode plan|approval|auto · /halt · /exit · /provider · /modelo · /mcp · /agent",
                        ),
                    }
                    continue;
                }
                if busy {
                    ui.history("system", "Ya hay una tarea en curso (/halt la detiene).");
                    continue;
                }
                ui.history("user", &input);
                running = Some(start(
                    &base,
                    &ui,
                    input.clone(),
                    input,
                    mode,
                    &pending,
                    None,
                ));
            }
            _ => {}
        }
    }
    if let Some((task, cancel)) = running {
        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
    }
    // The TUI leaves by itself after `exit`; give it a moment before forcing it.
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    write_task.abort();
    let _ = std::fs::remove_file(&socket);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::extract;

    #[test]
    fn the_embedded_tui_is_extracted_once_executable_and_named_by_its_content() {
        let dir = tempfile::tempdir().unwrap();
        let first = extract(b"#!/bin/sh\necho uno\n", dir.path()).unwrap();
        assert!(first.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first).unwrap().permissions().mode() & 0o111,
                0o111,
                "executable"
            );
        }
        let again = extract(b"#!/bin/sh\necho uno\n", dir.path()).unwrap();
        assert_eq!(first, again, "the same program is not written twice");
        let newer = extract(b"#!/bin/sh\necho dos\n", dir.path()).unwrap();
        assert_ne!(
            first, newer,
            "a different build gets its own file, so an old TUI is never run by mistake"
        );
        assert!(first.is_file() && newer.is_file());
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            2,
            "no temp files are left behind"
        );
    }
}
