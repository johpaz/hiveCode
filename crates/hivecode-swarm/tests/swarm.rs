//! The swarm against a fake model that answers by the profile that asks, and real git worktrees.
use hive_agent_core::provider::CancellationToken;
use hivecode_host::{
    Budget, BudgetLimits, Mode, ToolSet, budget_snapshot, open_budget, open_store,
};
use hivecode_swarm::{Swarm, SwarmConfig};
use hivecode_workspace::Workspaces;
use serde_json::{Value, json};
use std::{
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn sse(chunks: &[Value]) -> String {
    let mut body: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
    body.push_str("data: [DONE]\n\n");
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}
fn text(t: &str) -> String {
    sse(&[
        json!({"choices":[{"index":0,"delta":{"content":t},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}),
    ])
}
fn tool(name: &str, args: Value) -> String {
    sse(&[
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":name,"arguments":args.to_string()}}]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}),
    ])
}
const FAIL: &str = "HTTP/1.1 400 Bad Request\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}";

type Seen = Arc<Mutex<Vec<(String, Value)>>>;
/// `reply(kind, body)`; `kind` is the profile found in the system prompt.
async fn model(reply: impl Fn(&str, &Value) -> String + Send + Sync + 'static) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Seen = Arc::default();
    let (reply, log) = (Arc::new(reply), seen.clone());
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (reply, log) = (reply.clone(), log.clone());
            tokio::spawn(async move {
                let mut data = Vec::new();
                let mut buf = [0u8; 16384];
                let body = loop {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    data.extend_from_slice(&buf[..n]);
                    let s = String::from_utf8_lossy(&data).into_owned();
                    if let Some(split) = s.find("\r\n\r\n") {
                        let len = s[..split]
                            .to_ascii_lowercase()
                            .lines()
                            .find_map(|l| {
                                l.strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if data.len() >= split + 4 + len {
                            break s[split + 4..].to_owned();
                        }
                    }
                    if n == 0 {
                        return;
                    }
                };
                let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let system = body["messages"][0]["content"].as_str().unwrap_or("");
                let kind = [
                    "Scout",
                    "Builder",
                    "Quality Gate",
                    "gate de calidad",
                    "Spider",
                ]
                .iter()
                .find(|k| system.contains(&format!("Eres {k}")) || system.contains(*k))
                .map_or("other", |k| *k);
                let kind = if kind == "gate de calidad" {
                    "Quality Gate"
                } else {
                    kind
                };
                log.lock().unwrap().push((kind.to_owned(), body.clone()));
                let _ = socket.write_all(reply(kind, &body).as_bytes()).await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}/v1"), seen)
}
fn has_tool_result(body: &Value) -> bool {
    body["messages"]
        .as_array()
        .is_some_and(|m| m.iter().any(|x| x["role"] == "tool"))
}
fn last_is_tool_result(body: &Value) -> bool {
    body["messages"]
        .as_array()
        .and_then(|m| m.last())
        .is_some_and(|m| m["role"] == "tool")
}
fn tool_names(body: &Value) -> Vec<String> {
    body["tools"]
        .as_array()
        .map(|t| {
            t.iter()
                .filter_map(|x| x["function"]["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    std::fs::write(dir.path().join("a.txt"), "uno\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-q", "-m", "init"]);
    dir
}

struct Fixture {
    swarm: Swarm,
    seen: Seen,
    store: hivecode_host::Store,
    root: tempfile::TempDir,
    _state: tempfile::TempDir,
    _wt: tempfile::TempDir,
}
async fn fixture(
    reply: impl Fn(&str, &Value) -> String + Send + Sync + 'static,
    mode: Mode,
) -> Fixture {
    fixture_with(reply, mode, None).await
}
async fn fixture_with(
    reply: impl Fn(&str, &Value) -> String + Send + Sync + 'static,
    mode: Mode,
    limits: Option<BudgetLimits>,
) -> Fixture {
    fixture_full(reply, mode, limits, None).await
}
async fn fixture_full(
    reply: impl Fn(&str, &Value) -> String + Send + Sync + 'static,
    mode: Mode,
    limits: Option<BudgetLimits>,
    lifecycle: Option<hivecode_swarm::Lifecycle>,
) -> Fixture {
    let (url, seen) = model(reply).await;
    let root = repo();
    let state = tempfile::tempdir().unwrap();
    let wt = tempfile::tempdir().unwrap();
    let store = open_store(&state.path().join("db")).unwrap();
    let budget = limits.map(|l| {
        open_budget(&store, "run-1", &l).unwrap();
        Budget {
            objective_id: "run-1".into(),
            depth: 0,
        }
    });
    let swarm = Swarm::new(SwarmConfig {
        store: store.clone(),
        budget,
        provider: json!({"base_url": url, "api_key": "fake"}),
        model: "fake".into(),
        context_window: None,
        max_tool_calls: 20,
        web: None,
        allowed_programs: vec![],
        mode,
        session: "lead".into(),
        root: root.path().to_owned(),
        workspaces: Workspaces::new(wt.path()),
        tools_for: Arc::new(|_| vec![]),
        approve: Arc::new(|_, _| true),
        observe: None,
        findings: None,
        records: None,
        lifecycle,
    });
    Fixture {
        swarm,
        seen,
        store,
        root,
        _state: state,
        _wt: wt,
    }
}
async fn delegate(f: &Fixture, name: &str, args: Value) -> Value {
    f.swarm
        .execute(name, args, &CancellationToken::new())
        .await
        .unwrap()
}

#[tokio::test]
async fn workers_get_their_own_profile_and_tools_and_cannot_delegate() {
    let f = fixture(|kind, _| text(&format!("informe de {kind}")), Mode::Auto).await;
    let out = delegate(
        &f,
        "task_delegate_group",
        json!({"tasks":[
        {"worker_id":"scout","task_description":"explora src"},
        {"worker_id":"builder","task_description":"implementa"}]}),
    )
    .await;
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(out["results"].as_array().unwrap().len(), 2);
    let seen = f.seen.lock().unwrap();
    let scout = &seen.iter().find(|(k, _)| k == "Scout").unwrap().1;
    let builder = &seen.iter().find(|(k, _)| k == "Builder").unwrap().1;
    let (scout_tools, builder_tools) = (tool_names(scout), tool_names(builder));
    assert!(
        scout_tools.contains(&"fs_read".into()) && !scout_tools.contains(&"fs_write".into()),
        "a scout only reads: {scout_tools:?}"
    );
    assert!(builder_tools.contains(&"fs_write".into()));
    assert!(
        ![&scout_tools, &builder_tools]
            .iter()
            .any(|t| t.contains(&"task_delegate".into())),
        "workers cannot delegate"
    );
    assert_eq!(out["results"][0]["result"], "informe de Scout");
}

#[tokio::test]
async fn a_task_waits_for_its_dependency_and_receives_its_handoff() {
    let order: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let log = order.clone();
    let f = fixture(
        move |kind, _| {
            log.lock()
                .unwrap()
                .push(if kind == "Scout" { "scout" } else { "builder" });
            text(if kind == "Scout" {
                "HALLAZGO-CLAVE-91"
            } else {
                "construido"
            })
        },
        Mode::Auto,
    )
    .await;
    let out = delegate(
        &f,
        "task_delegate_group",
        json!({"tasks":[
        {"worker_id":"builder","task_description":"implementa","ref":"B","after":["S"]},
        {"worker_id":"scout","task_description":"explora","ref":"S"}]}),
    )
    .await;
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(
        *order.lock().unwrap(),
        ["scout", "builder"],
        "the dependency ran first"
    );
    let seen = f.seen.lock().unwrap();
    let builder = &seen.iter().find(|(k, _)| k == "Builder").unwrap().1;
    assert!(
        builder.to_string().contains("HALLAZGO-CLAVE-91"),
        "the handoff reached the dependent"
    );
    assert_eq!(
        out["results"][0]["ref"], "S",
        "results come back in the order they finished"
    );
}

#[tokio::test]
async fn when_a_dependency_fails_its_dependents_never_start() {
    let builder_calls = Arc::new(Mutex::new(0));
    let counter = builder_calls.clone();
    let f = fixture(
        move |kind, _| {
            if kind == "Builder" {
                *counter.lock().unwrap() += 1;
            }
            if kind == "Scout" {
                FAIL.into()
            } else {
                text("ok")
            }
        },
        Mode::Auto,
    )
    .await;
    let out = delegate(
        &f,
        "task_delegate_group",
        json!({"tasks":[
        {"worker_id":"scout","task_description":"explora","ref":"S"},
        {"worker_id":"builder","task_description":"implementa","ref":"B","after":["S"]}]}),
    )
    .await;
    assert_eq!(out["ok"], false);
    let blocked = out["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["ref"] == "B")
        .unwrap();
    assert_eq!(blocked["blocked_by"], json!(["S"]));
    assert_eq!(
        *builder_calls.lock().unwrap(),
        0,
        "no tokens were spent on a task that could not start"
    );
}

#[tokio::test]
async fn bad_groups_are_refused_before_anything_runs() {
    let f = fixture(|_, _| text("x"), Mode::Auto).await;
    let cases = [
        (
            json!({"tasks":[{"worker_id":"builder","task_description":"a"},{"worker_id":"builder","task_description":"b"}]}),
            "own instance",
        ),
        (
            json!({"tasks":[{"worker_id":"scout","task_description":"a","ref":"X","after":["Y"]},{"worker_id":"scout","task_description":"b","ref":"Y","after":["X"]}]}),
            "cycle",
        ),
        (
            json!({"tasks":[{"worker_id":"scout","task_description":"a","after":["nada"]}]}),
            "not in this group",
        ),
        (
            json!({"tasks":[{"worker_id":"scout","task_description":"a","ref":"X"},{"worker_id":"scout","task_description":"b","ref":"X"}]}),
            "used twice",
        ),
    ];
    for (args, expected) in cases {
        let out = delegate(&f, "task_delegate_group", args).await;
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains(expected), "{out}");
    }
    assert!(f.seen.lock().unwrap().is_empty(), "no model call was made");
    let unknown = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"bee","task_description":"yo"}),
    )
    .await;
    assert!(
        unknown["error"]
            .as_str()
            .unwrap()
            .contains("worker not found"),
        "the lead cannot be delegated to: {unknown}"
    );
    let bad = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"builder#9","task_description":"x"}),
    )
    .await;
    assert!(bad["error"].as_str().unwrap().contains("instance"));
}

#[tokio::test]
async fn two_builders_work_at_once_and_the_second_instance_is_merged_back() {
    let f = fixture(
        |kind, body| {
            if kind != "Builder" {
                return text("ok");
            }
            if has_tool_result(body) {
                return text("listo");
            }
            // The two builders are told apart by what they were asked.
            let asked = body.to_string();
            let (path, content) = if asked.contains("segunda-tarea") {
                ("dos.txt", "hecho por la instancia 2\n")
            } else {
                ("uno.txt", "hecho por la instancia 1\n")
            };
            tool("fs_write", json!({"path": path, "content": content}))
        },
        Mode::Auto,
    )
    .await;
    let out = delegate(
        &f,
        "task_delegate_group",
        json!({"tasks":[
        {"worker_id":"builder","task_description":"primera-tarea"},
        {"worker_id":"builder#2","task_description":"segunda-tarea"}]}),
    )
    .await;
    assert_eq!(out["ok"], true, "{out}");
    let by = |w: &str| {
        out["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["worker_id"] == w)
            .unwrap()
            .clone()
    };
    assert!(
        by("builder").get("merge").is_none(),
        "the first instance works in the lead's own worktree"
    );
    assert_eq!(by("builder#2")["merge"], "integrated");
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("uno.txt")).unwrap(),
        "hecho por la instancia 1\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("dos.txt")).unwrap(),
        "hecho por la instancia 2\n"
    );
    let worktrees = Command::new("git")
        .args(["worktree", "list"])
        .current_dir(f.root.path())
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&worktrees.stdout).lines().count(),
        1,
        "the private copy is removed once merged"
    );
}

#[tokio::test]
async fn workers_obey_the_mode_so_a_builder_cannot_write_in_plan_mode() {
    let f = fixture(
        |kind, body| {
            if kind == "Builder" && !has_tool_result(body) {
                return tool("fs_write", json!({"path": "x.txt", "content": "no"}));
            }
            text("hecho")
        },
        Mode::Plan,
    )
    .await;
    let out = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"builder","task_description":"escribe"}),
    )
    .await;
    assert_eq!(out["ok"], true);
    assert!(
        !f.root.path().join("x.txt").exists(),
        "plan mode holds for workers too"
    );
}

#[tokio::test]
async fn a_worker_cannot_call_a_tool_its_profile_does_not_have() {
    let f = fixture(
        |kind, body| {
            // A scout that tries to write anyway.
            if kind == "Scout" && !has_tool_result(body) {
                return tool("fs_write", json!({"path": "colado.txt", "content": "x"}));
            }
            text("fin")
        },
        Mode::Auto,
    )
    .await;
    let out = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"scout","task_description":"explora"}),
    )
    .await;
    let _ = out;
    assert!(
        !f.root.path().join("colado.txt").exists(),
        "a scout never writes, whatever the model asks"
    );
}

#[tokio::test]
async fn a_revised_worker_keeps_its_context_and_its_task_id() {
    let f = fixture(
        |_, body| {
            let said = body.to_string();
            text(if said.contains("FEEDBACK-77") {
                "corregido"
            } else {
                "primer informe"
            })
        },
        Mode::Auto,
    )
    .await;
    let first = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"scout","task_description":"explora-inicial","ref":"S"}),
    )
    .await;
    assert_eq!(first["ok"], true);
    let id = first["task_id"].as_str().unwrap().to_owned();

    let second = delegate(
        &f,
        "task_revise",
        json!({"task_id": id, "feedback": "FEEDBACK-77 falta el módulo b"}),
    )
    .await;
    assert_eq!(second["result"], "corregido");
    assert_eq!(second["task_id"], id, "a revision is the same task");

    {
        let seen = f.seen.lock().unwrap();
        let sent = seen.last().unwrap().1.to_string();
        assert!(
            sent.contains("explora-inicial") && sent.contains("primer informe"),
            "the worker remembers its first run: {sent}"
        );
        assert!(sent.contains("Revisión pedida por el coordinador"));
    }

    // The ref works in place of the id, and the status shows two runs.
    assert_eq!(
        delegate(
            &f,
            "task_revise",
            json!({"task_id":"S","feedback":"FEEDBACK-77 otra vez"})
        )
        .await["ok"],
        true
    );
    let status = delegate(&f, "task_status", json!({})).await;
    assert_eq!(status["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(status["tasks"][0]["runs"], 3);
    assert_eq!(status["tasks"][0]["ok"], true);
}

#[tokio::test]
async fn revising_a_private_instance_merges_its_new_work_too_and_unknown_ids_are_refused() {
    let f = fixture(
        |kind, body| {
            if kind != "Builder" {
                return text("ok");
            }
            if last_is_tool_result(body) {
                return text("listo");
            }
            let path = if body.to_string().contains("FEEDBACK-77") {
                "dos-b.txt"
            } else {
                "dos-a.txt"
            };
            tool("fs_write", json!({"path": path, "content": "x\n"}))
        },
        Mode::Auto,
    )
    .await;
    let first = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"builder#2","task_description":"crea dos-a"}),
    )
    .await;
    assert_eq!(first["merge"], "integrated", "{first}");
    assert!(f.root.path().join("dos-a.txt").exists());
    let id = first["task_id"].as_str().unwrap();
    let second = delegate(
        &f,
        "task_revise",
        json!({"task_id": id, "feedback": "FEEDBACK-77 crea también dos-b"}),
    )
    .await;
    assert_eq!(second["merge"], "integrated", "{second}");
    assert!(
        f.root.path().join("dos-b.txt").exists(),
        "the revision's own work reached the lead's worktree"
    );
    let worktrees = Command::new("git")
        .args(["worktree", "list"])
        .current_dir(f.root.path())
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&worktrees.stdout).lines().count(),
        1
    );

    let unknown = delegate(
        &f,
        "task_revise",
        json!({"task_id": "D99", "feedback": "x"}),
    )
    .await;
    assert!(
        unknown["error"]
            .as_str()
            .unwrap()
            .contains("no delegated task")
    );
    let empty = delegate(&f, "task_revise", json!({"task_id": id, "feedback": "  "})).await;
    assert_eq!(empty["ok"], false);
}

#[tokio::test]
async fn every_worker_draws_from_one_budget_and_a_denied_call_costs_nothing() {
    // Three scouts want one model call each; the whole run is allowed two.
    let f = fixture_with(
        |_, _| text("informe"),
        Mode::Auto,
        Some(BudgetLimits {
            max_model_calls: 2,
            ..Default::default()
        }),
    )
    .await;
    let out = delegate(
        &f,
        "task_delegate_group",
        json!({"tasks":[
        {"worker_id":"scout","task_description":"a"},
        {"worker_id":"scout","task_description":"b"},
        {"worker_id":"scout","task_description":"c"}]}),
    )
    .await;
    let results = out["results"].as_array().unwrap();
    assert_eq!(
        results.iter().filter(|r| r["ok"] == true).count(),
        2,
        "{out}"
    );
    let denied = results.iter().find(|r| r["ok"] == false).unwrap();
    assert!(
        denied["error"]
            .as_str()
            .unwrap()
            .contains("OBJECTIVE_LIMIT"),
        "{denied}"
    );
    assert_eq!(
        f.seen.lock().unwrap().len(),
        2,
        "the third worker never reached the model"
    );
    let used = budget_snapshot(&f.store, "run-1").unwrap();
    assert_eq!(used["model_calls"], 2, "{used}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_worker_waits_for_a_sibling_task_and_gets_its_handoff_without_polling() {
    let f = fixture(
        |kind, body| match kind {
            "Scout" => {
                // Slow on purpose: the builder asks for it before it is done.
                std::thread::sleep(std::time::Duration::from_millis(400));
                text("HALLAZGO-LENTO-31")
            }
            "Builder" if !last_is_tool_result(body) => tool("wait_for", json!({"ref": "S"})),
            _ => text("construido"),
        },
        Mode::Auto,
    )
    .await;
    let out = delegate(
        &f,
        "task_delegate_group",
        json!({"tasks":[
        {"worker_id":"builder","task_description":"implementa","ref":"B"},
        {"worker_id":"scout","task_description":"explora","ref":"S"}]}),
    )
    .await;
    assert_eq!(out["ok"], true, "{out}");
    let seen = f.seen.lock().unwrap();
    let builder_second = seen
        .iter()
        .filter(|(k, _)| k == "Builder")
        .nth(1)
        .expect("the builder continued after waiting");
    assert!(
        builder_second.1.to_string().contains("HALLAZGO-LENTO-31"),
        "it got the scout's handoff"
    );
}

#[tokio::test]
async fn waiting_for_a_ref_nobody_delegated_fails_at_once_instead_of_hanging() {
    let f = fixture(
        |kind, body| {
            if kind == "Builder" && !last_is_tool_result(body) {
                return tool("wait_for", json!({"ref": "nadie"}));
            }
            text("sigo sin eso")
        },
        Mode::Auto,
    )
    .await;
    let out = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"builder","task_description":"x"}),
    )
    .await;
    assert_eq!(out["ok"], true);
    let seen = f.seen.lock().unwrap();
    assert!(
        seen.last()
            .unwrap()
            .1
            .to_string()
            .contains("was never delegated")
    );
}

#[tokio::test]
async fn the_same_question_over_unchanged_files_is_answered_from_the_saved_report() {
    let f = fixture(|_, _| text("INFORME-DEL-SCOUT"), Mode::Auto).await;
    let calls = |f: &Fixture| f.seen.lock().unwrap().len();
    let ask = |refresh: bool, description: &'static str| {
        let f = &f;
        async move {
            delegate(
                f,
                "task_delegate",
                json!({"worker_id":"scout","task_description":description,"refresh":refresh}),
            )
            .await
        }
    };

    let first = ask(false, "revisa a.txt y resume").await;
    assert!(first.get("reused").is_none());
    assert_eq!(calls(&f), 1);

    let again = ask(false, "revisa  a.txt   y resume").await;
    assert_eq!(
        again["reused"], true,
        "whitespace and case do not make it another question: {again}"
    );
    assert!(
        again["result"]
            .as_str()
            .unwrap()
            .contains("INFORME-DEL-SCOUT")
    );
    assert_eq!(calls(&f), 1, "no model was called");
    assert!(
        again.get("task_id").is_none(),
        "a reused report has no session to revise"
    );

    assert!(
        ask(true, "revisa a.txt y resume")
            .await
            .get("reused")
            .is_none(),
        "refresh: true runs it again"
    );
    assert_eq!(calls(&f), 2);

    // The file changes: the saved report no longer applies.
    std::fs::write(
        f.root.path().join("a.txt"),
        "uno\ncontenido nuevo y más largo\n",
    )
    .unwrap();
    assert!(
        ask(false, "revisa a.txt y resume")
            .await
            .get("reused")
            .is_none()
    );
    assert_eq!(calls(&f), 3);

    // A question that names no file has nothing to go stale on: it is never reused.
    ask(false, "explica la arquitectura").await;
    let before = calls(&f);
    assert!(
        ask(false, "explica la arquitectura")
            .await
            .get("reused")
            .is_none()
    );
    assert_eq!(calls(&f), before + 1);
}

#[tokio::test]
async fn only_readers_reuse_reports_a_builder_always_runs() {
    let f = fixture(|_, _| text("hecho"), Mode::Auto).await;
    for _ in 0..2 {
        let out = delegate(
            &f,
            "task_delegate",
            json!({"worker_id":"builder","task_description":"edita a.txt"}),
        )
        .await;
        assert!(out.get("reused").is_none());
    }
    assert_eq!(f.seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn the_board_times_out_instead_of_hanging_and_obeys_cancellation() {
    use hivecode_swarm::board::{Board, WaitError};
    use std::time::Duration;
    let board = Board::default();
    let cancel = CancellationToken::new();
    assert_eq!(
        board.wait("x", Duration::from_millis(50), &cancel).await,
        Err(WaitError::Unknown)
    );
    board.announce("x");
    assert_eq!(
        board.wait("x", Duration::from_millis(50), &cancel).await,
        Err(WaitError::Timeout),
        "never settled"
    );
    let early = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        early.cancel();
    });
    assert_eq!(
        board.wait("x", Duration::from_secs(30), &cancel).await,
        Err(WaitError::Cancelled)
    );
    board.settle("x", true, "listo");
    let fresh = CancellationToken::new();
    let got = board
        .wait("x", Duration::from_millis(50), &fresh)
        .await
        .unwrap();
    assert_eq!(
        (got.ok, got.handoff.as_str()),
        (true, "listo"),
        "a settled ref answers at once, later too"
    );
}

#[test]
fn a_specialty_is_chosen_from_the_task_unless_one_is_asked_for_and_must_belong_to_the_profile() {
    use hivecode_swarm::specialties::{for_owner, select};
    let id = |owner: &str, task: &str, req: Option<&str>| {
        select(owner, task, req).unwrap().map(|s| s.id)
    };
    assert_eq!(
        id("builder", "arregla el endpoint de login", None),
        Some("backend")
    );
    assert_eq!(
        id("builder", "agrega una pantalla de inicio", None),
        Some("frontend")
    );
    assert_eq!(id("builder", "migración del esquema", None), Some("data"));
    assert_eq!(
        id("builder", "configura el pipeline de CI", None),
        Some("devops")
    );
    assert_eq!(
        id("builder", "renombra una variable", None),
        Some("integration"),
        "no match falls back to integration"
    );
    assert_eq!(
        id("verifier", "audita los permisos y los secretos", None),
        Some("security")
    );
    assert_eq!(
        id("verifier", "comprueba que el comando funciona", None),
        Some("acceptance")
    );
    assert_eq!(
        id("scout", "mapea el módulo de pagos", None),
        Some("repository")
    );
    assert_eq!(id("spider", "busca la documentación", None), Some("web"));
    assert_eq!(
        id("bee", "lo que sea", None),
        None,
        "the lead has no specialties"
    );

    // Asked for: with or without the `worker/` prefix models like to write.
    assert_eq!(id("verifier", "x", Some("security")), Some("security"));
    assert_eq!(
        id("verifier", "x", Some("verifier/Security")),
        Some("security")
    );
    let error = select("builder", "x", Some("security")).unwrap_err();
    assert!(
        error.contains("not available to builder")
            && error.contains("backend, frontend, data, devops, integration"),
        "{error}"
    );
    assert!(for_owner("bee").is_empty());
}

#[tokio::test]
async fn the_worker_brief_carries_its_specialty_and_a_wrong_one_is_refused_before_anything_runs() {
    let f = fixture(|_, _| text("hecho"), Mode::Auto).await;
    let out = delegate(&f, "task_delegate_group", json!({"tasks":[
        {"worker_id":"builder","task_description":"arregla el endpoint de login"},
        {"worker_id":"verifier","task_description":"audita permisos","specialty":"verifier/security"}]})).await;
    assert_eq!(out["ok"], true, "{out}");
    let specialty = |worker: &str| {
        out["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["worker_id"] == worker)
            .unwrap()["specialty"]
            .clone()
    };
    assert_eq!(
        (specialty("builder"), specialty("verifier")),
        (json!("backend"), json!("security"))
    );
    {
        let seen = f.seen.lock().unwrap();
        // The fake tells workers apart by their prompt and the verifier's mentions "Builder": look the
        // brief up by what it says instead.
        let bodies: Vec<String> = seen.iter().map(|(_, b)| b.to_string()).collect();
        assert!(bodies.iter().any(|b| b.contains("Especialidad `backend`")
            && b.contains("Define contratos de entrada/salida")));
        assert!(bodies.iter().any(|b| b.contains("Especialidad `security`")));
        assert!(
            !bodies
                .iter()
                .any(|b| b.contains("Especialidad `acceptance`"))
        );
    }

    let before = f.seen.lock().unwrap().len();
    let bad = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"builder","task_description":"x","specialty":"security"}),
    )
    .await;
    assert_eq!(bad["ok"], false);
    assert!(
        bad["error"].as_str().unwrap().contains("Valid specialties"),
        "{bad}"
    );
    assert_eq!(
        f.seen.lock().unwrap().len(),
        before,
        "no model call for a refused specialty"
    );

    // A revision does not repeat the brief: the worker already has it in its own conversation.
    let first = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"builder","task_description":"corrige el servicio"}),
    )
    .await;
    let id = first["task_id"].as_str().unwrap().to_owned();
    let second = delegate(
        &f,
        "task_revise",
        json!({"task_id": id, "feedback": "falta validar"}),
    )
    .await;
    assert!(second.get("specialty").is_none());
}

#[tokio::test]
async fn the_lifecycle_tells_who_was_delegated_who_waits_and_how_each_one_ended() {
    use hivecode_swarm::SwarmEvent;
    let events: Arc<Mutex<Vec<SwarmEvent>>> = Arc::default();
    let log = events.clone();
    let f = fixture_full(
        |kind, _| {
            if kind == "Scout" {
                FAIL.into()
            } else {
                text("hecho")
            }
        },
        Mode::Auto,
        None,
        Some(Arc::new(move |event| {
            log.lock().unwrap().push(event.clone())
        })),
    )
    .await;
    // The scout fails, so the builder that waits for it never starts: no `Delegated` for it.
    delegate(
        &f,
        "task_delegate_group",
        json!({"tasks":[
        {"worker_id":"scout","task_description":"explora","ref":"S"},
        {"worker_id":"builder","task_description":"implementa","ref":"B","after":["S"]}]}),
    )
    .await;
    {
        let seen = events.lock().unwrap().clone();
        assert_eq!(
            seen[0],
            SwarmEvent::Waiting {
                worker: "builder".into(),
                for_refs: vec!["S".into()],
                reason: "dependencia"
            }
        );
        let SwarmEvent::Delegated {
            id,
            from,
            to,
            summary,
        } = &seen[1]
        else {
            panic!("{seen:?}")
        };
        assert_eq!(
            (from.as_str(), to.as_str(), summary.as_str()),
            ("bee", "scout", "explora")
        );
        let SwarmEvent::Finished {
            id: end,
            to: ended,
            ok,
            ..
        } = &seen[2]
        else {
            panic!("{seen:?}")
        };
        assert_eq!(
            (end, ended.as_str(), *ok),
            (id, "scout", false),
            "the same delegation id ends as a failure"
        );
        assert_eq!(
            seen.len(),
            3,
            "the blocked builder is not delegated to: {seen:?}"
        );
    }

    // A worker that is not a worker produces no events at all.
    let before = events.lock().unwrap().len();
    delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"nadie","task_description":"x"}),
    )
    .await;
    assert_eq!(events.lock().unwrap().len(), before);

    // And a good one: delegation then handoff.
    let ok = delegate(
        &f,
        "task_delegate",
        json!({"worker_id":"spider","task_description":"busca"}),
    )
    .await;
    assert_eq!(ok["ok"], true);
    let seen = events.lock().unwrap().clone();
    assert!(matches!(&seen[before], SwarmEvent::Delegated { to, .. } if to == "spider"));
    assert!(
        matches!(&seen[before + 1], SwarmEvent::Finished { ok: true, summary, .. } if summary == "hecho")
    );
}
