//! The real `hivecode` binary against a local fake model and a real git repository.
use serde_json::{Value, json};
use std::{path::Path, process::Command};
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
fn tool_call(name: &str, args: Value) -> String {
    sse(&[
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":name,"arguments":args.to_string()}}]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}),
    ])
}
fn answer(text: &str) -> String {
    sse(&[
        json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":6}}),
    ])
}
async fn serve(script: Vec<String>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        for reply in script {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                data.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&data).into_owned();
                if let Some(split) = text.find("\r\n\r\n") {
                    let len = text[..split]
                        .to_ascii_lowercase()
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if data.len() >= split + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            socket.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    port
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
fn run(port: u16, project: &Path, home: &Path, mode: &str, task: &str) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_hivecode"))
        .args([
            "run",
            "--headless",
            "--model",
            "fake",
            "--mode",
            mode,
            "--root",
        ])
        .arg(project)
        .args(["--base-url", &format!("http://127.0.0.1:{port}/v1")])
        .arg(task)
        .env("HIVECODE_API_KEY", "fake")
        .env("HIVE_HOME", home)
        .env("TMPDIR", home)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "stderr: {}\nstdout: {stdout}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_str(stdout.lines().last().unwrap()).unwrap()
}
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    std::fs::write(dir.path().join("a.txt"), "uno\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-q", "-m", "init"]);
    dir
}

#[tokio::test]
async fn auto_mode_edits_in_a_worktree_and_integrates_the_result_into_the_project() {
    let port = serve(vec![
        tool_call(
            "fs_write",
            json!({"path":"nuevo.txt","content":"creado por el agente\n"}),
        ),
        answer("hecho"),
    ])
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let done = tokio::task::spawn_blocking({
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        move || run(port, &p, &h, "auto", "crea nuevo.txt")
    })
    .await
    .unwrap();
    assert_eq!(done["content"], "hecho");
    assert_eq!(done["integration"], "integrated");
    assert_eq!(
        std::fs::read_to_string(project.path().join("nuevo.txt")).unwrap(),
        "creado por el agente\n"
    );
    let leftovers = Command::new("git")
        .args(["worktree", "list"])
        .current_dir(project.path())
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&leftovers.stdout).lines().count(),
        1,
        "the task worktree is removed"
    );
}

#[tokio::test]
async fn plan_mode_leaves_the_project_untouched_and_needs_no_worktree() {
    let port = serve(vec![
        tool_call("fs_write", json!({"path":"x.txt","content":"x"})),
        answer("solo plan"),
    ])
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let done = tokio::task::spawn_blocking({
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        move || run(port, &p, &h, "plan", "crea x")
    })
    .await
    .unwrap();
    assert_eq!(done["integration"], "noop");
    assert!(!project.path().join("x.txt").exists());
}

#[tokio::test]
async fn the_model_can_commit_with_the_git_tools_inside_its_worktree() {
    let port = serve(vec![
        tool_call("fs_write", json!({"path":"nuevo.txt","content":"hola\n"})),
        tool_call("git_commit", json!({"message":"agrega nuevo.txt"})),
        answer("commit hecho"),
    ])
    .await;
    let project = repo();
    git(project.path(), &["config", "user.name", "t"]);
    git(project.path(), &["config", "user.email", "t@t"]);
    git(project.path(), &["config", "commit.gpgsign", "false"]);
    let home = tempfile::tempdir().unwrap();
    let done = tokio::task::spawn_blocking({
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        move || run(port, &p, &h, "auto", "crea nuevo.txt y haz commit")
    })
    .await
    .unwrap();
    assert_eq!(done["content"], "commit hecho");
    // The commit was made on the task branch inside the worktree; its content still reaches the
    // project as an uncommitted change (the person decides what to commit), and the branch is gone.
    assert_eq!(
        std::fs::read_to_string(project.path().join("nuevo.txt")).unwrap(),
        "hola\n"
    );
    let branches = Command::new("git")
        .args(["branch", "--list", "hivecode/*"])
        .current_dir(project.path())
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());
}

#[tokio::test]
async fn a_configured_mcp_server_is_connected_and_its_tool_can_be_called_in_auto_mode() {
    let peer =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../hivecode-tools/tests/fixtures/mcp_peer.py");
    let home = tempfile::tempdir().unwrap();
    let receipt = home.path().join("receipt.jsonl");
    std::fs::write(
        home.path().join("mcp.json"),
        json!({"servers": {"math": {"command": "python3", "args": [peer, "normal", receipt], "timeout_ms": 5000},
                           "roto": {"command": "/no/existe/mcp", "timeout_ms": 1000}}})
            .to_string(),
    ).unwrap();
    let port = serve(vec![
        tool_call("math__add", json!({"a": 20, "b": 22})),
        answer("son 42"),
    ])
    .await;
    let project = repo();
    let done = tokio::task::spawn_blocking({
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        move || run(port, &p, &h, "auto", "suma 20 y 22")
    })
    .await
    .unwrap();
    assert_eq!(
        done["content"], "son 42",
        "the broken server did not stop the run"
    );
}

/// A fake model that answers by who asks (found in the system prompt), for the swarm.
async fn serve_by(reply: impl Fn(&str, &Value) -> String + Send + Sync + 'static) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let reply = std::sync::Arc::new(reply);
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let reply = reply.clone();
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
                let system = body["messages"][0]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let who = ["BEE", "Scout", "Builder"]
                    .into_iter()
                    .find(|w| system.contains(&format!("Eres {w}")))
                    .unwrap_or("other");
                let _ = socket.write_all(reply(who, &body).as_bytes()).await;
            });
        }
    });
    port
}

#[tokio::test]
async fn the_swarm_flag_makes_bee_delegate_to_workers_and_their_work_reaches_the_project() {
    let port = serve_by(|who, body| {
        let answered_tool = body["messages"].as_array().is_some_and(|m| m.iter().any(|x| x["role"] == "tool"));
        match (who, answered_tool) {
            ("BEE", false) => tool_call(
                "task_delegate_group",
                json!({"tasks":[
                    {"worker_id":"scout","task_description":"explora el proyecto","ref":"S"},
                    {"worker_id":"builder","task_description":"crea equipo.txt","ref":"B","after":["S"]}]}),
            ),
            ("BEE", true) => answer("equipo listo"),
            ("Builder", false) => tool_call("fs_write", json!({"path":"equipo.txt","content":"del builder\n"})),
            ("Builder", true) => answer("construido"),
            _ => answer("HALLAZGO-DEL-SCOUT"),
        }
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let out = tokio::task::spawn_blocking({
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        move || {
            Command::new(env!("CARGO_BIN_EXE_hivecode"))
                .args([
                    "run",
                    "--headless",
                    "--swarm",
                    "--model",
                    "fake",
                    "--mode",
                    "auto",
                    "--root",
                ])
                .arg(&p)
                .args(["--base-url", &format!("http://127.0.0.1:{port}/v1")])
                .arg("monta un equipo")
                .env("HIVECODE_API_KEY", "fake")
                .env("HIVE_HOME", &h)
                .env("TMPDIR", &h)
                .output()
                .unwrap()
        }
    })
    .await
    .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "stderr: {}\nstdout: {stdout}",
        String::from_utf8_lossy(&out.stderr)
    );
    let done: Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(done["content"], "equipo listo");
    assert_eq!(done["integration"], "integrated");
    assert_eq!(
        std::fs::read_to_string(project.path().join("equipo.txt")).unwrap(),
        "del builder\n"
    );
    // BEE asked twice, the builder twice and the scout once: all against the same run budget.
    assert_eq!(done["budget"]["model_calls"], 5, "{done}");
    assert!(
        stdout.contains(r#""type":"worker_tool""#) && stdout.contains("fs_write"),
        "the workers' tool use is reported: {stdout}"
    );
}

#[tokio::test]
async fn the_swarm_goes_through_the_harness_which_runs_the_project_and_asks_for_one_repair() {
    let port = serve_by(|who, body| {
        if who != "BEE" {
            return answer("x");
        }
        let messages = body["messages"].as_array().unwrap();
        let last_is_tool = messages.last().is_some_and(|m| m["role"] == "tool");
        let last_user = messages
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .and_then(|m| m["content"].as_str())
            .unwrap_or("");
        if last_is_tool {
            answer("hecho")
        } else if last_user.contains("salió en rojo") {
            tool_call("fs_write", json!({"path":"equipo.txt","content":"ya\n"}))
        } else {
            answer("no toqué nada")
        }
    })
    .await;
    let project = repo();
    std::fs::create_dir_all(project.path().join(".hivecode")).unwrap();
    std::fs::write(
        project.path().join(".hivecode/verify.json"),
        r#"{"test":"test -f equipo.txt"}"#,
    )
    .unwrap();
    let home = tempfile::tempdir().unwrap();
    let out = tokio::task::spawn_blocking({
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        move || {
            Command::new(env!("CARGO_BIN_EXE_hivecode"))
                .args([
                    "run",
                    "--headless",
                    "--swarm",
                    "--model",
                    "fake",
                    "--mode",
                    "auto",
                    "--root",
                ])
                .arg(&p)
                .args(["--base-url", &format!("http://127.0.0.1:{port}/v1")])
                .arg("corrige el bug agregando equipo.txt")
                .env("HIVECODE_API_KEY", "fake")
                .env("HIVE_HOME", &h)
                .env("TMPDIR", &h)
                .output()
                .unwrap()
        }
    })
    .await
    .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "stderr: {}\nstdout: {stdout}",
        String::from_utf8_lossy(&out.stderr)
    );
    let done: Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(done["harness"]["route"], "scoped", "{done}");
    assert_eq!(done["harness"]["repair_cycles"], 1);
    assert_eq!(done["harness"]["status"], "completed");
    assert!(done["content"].as_str().unwrap().contains("todo en verde"));
    assert_eq!(
        std::fs::read_to_string(project.path().join("equipo.txt")).unwrap(),
        "ya\n"
    );
}

fn hivecode(home: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hivecode"))
        .args(args)
        .env("HIVE_HOME", home)
        .env("TMPDIR", home)
        .output()
        .unwrap()
}

#[tokio::test]
async fn a_run_is_recorded_in_the_history_and_can_be_rolled_back_once() {
    let port = serve(vec![
        tool_call(
            "fs_write",
            json!({"path":"nuevo.txt","content":"del agente\n"}),
        ),
        answer("hecho"),
    ])
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let done = tokio::task::spawn_blocking({
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        move || run(port, &p, &h, "auto", "crea nuevo.txt")
    })
    .await
    .unwrap();
    let id = done["run_id"].as_str().unwrap().to_owned();
    assert_eq!(done["undoable"], true);
    assert!(project.path().join("nuevo.txt").exists());

    let listed = hivecode(home.path(), &["history", "--json"]);
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let runs: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(runs[0]["id"], id.as_str());
    assert_eq!(
        (
            runs[0]["integration"].as_str(),
            runs[0]["has_patch"].as_bool(),
            runs[0]["rolled_back"].as_bool()
        ),
        (Some("integrated"), Some(true), Some(false))
    );
    assert_eq!(runs[0]["objective"], "crea nuevo.txt");
    let text = hivecode(home.path(), &["history"]);
    assert!(String::from_utf8_lossy(&text.stdout).contains("se puede deshacer"));

    let undone = hivecode(home.path(), &["rollback", &id]);
    assert!(
        undone.status.success(),
        "{}",
        String::from_utf8_lossy(&undone.stderr)
    );
    assert!(
        !project.path().join("nuevo.txt").exists(),
        "what the run created is gone"
    );
    let runs: Value =
        serde_json::from_slice(&hivecode(home.path(), &["history", "--json"]).stdout).unwrap();
    assert_eq!(runs[0]["rolled_back"], true);

    let again = hivecode(home.path(), &["rollback", &id]);
    assert!(!again.status.success());
    assert!(String::from_utf8_lossy(&again.stderr).contains("ya se deshizo"));
    assert!(
        !hivecode(home.path(), &["rollback", "run-inexistente"])
            .status
            .success()
    );
}

#[tokio::test]
async fn a_run_that_changed_nothing_has_nothing_to_undo_and_a_changed_project_is_not_clobbered() {
    let port = serve(vec![answer("solo plan")]).await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let done = tokio::task::spawn_blocking({
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        move || run(port, &p, &h, "plan", "piensa")
    })
    .await
    .unwrap();
    assert_eq!(done["undoable"], false);
    let id = done["run_id"].as_str().unwrap();
    let refused = hivecode(home.path(), &["rollback", id]);
    assert!(String::from_utf8_lossy(&refused.stderr).contains("no dejó cambios que deshacer"));

    // A run that edited a.txt, then the person edits the same line: the rollback refuses.
    let port = serve(vec![
        tool_call("fs_write", json!({"path":"a.txt","content":"del agente\n"})),
        answer("hecho"),
    ])
    .await;
    let done = tokio::task::spawn_blocking({
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        move || run(port, &p, &h, "auto", "edita a.txt")
    })
    .await
    .unwrap();
    std::fs::write(
        project.path().join("a.txt"),
        "editado luego por la persona\n",
    )
    .unwrap();
    let blocked = hivecode(home.path(), &["rollback", done["run_id"].as_str().unwrap()]);
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("changed since this run"));
    assert_eq!(
        std::fs::read_to_string(project.path().join("a.txt")).unwrap(),
        "editado luego por la persona\n"
    );
}

#[tokio::test]
async fn a_scout_report_is_reused_by_the_next_run_on_the_same_project() {
    let scout_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = scout_calls.clone();
    let port = serve_by(move |who, body| {
        let answered_tool = body["messages"]
            .as_array()
            .is_some_and(|m| m.iter().any(|x| x["role"] == "tool"));
        match (who, answered_tool) {
            ("BEE", false) => tool_call(
                "task_delegate",
                json!({"worker_id":"scout","task_description":"revisa a.txt y resume"}),
            ),
            ("BEE", true) => answer("listo"),
            _ => {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                answer("INFORME-DEL-SCOUT")
            }
        }
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    for expected in [1, 1] {
        let (p, h) = (project.path().to_owned(), home.path().to_owned());
        let out = tokio::task::spawn_blocking(move || {
            Command::new(env!("CARGO_BIN_EXE_hivecode"))
                .args([
                    "run",
                    "--headless",
                    "--swarm",
                    "--model",
                    "fake",
                    "--mode",
                    "auto",
                    "--root",
                ])
                .arg(&p)
                .args(["--base-url", &format!("http://127.0.0.1:{port}/v1")])
                .arg("monta un equipo")
                .env("HIVECODE_API_KEY", "fake")
                .env("HIVE_HOME", &h)
                .env("TMPDIR", &h)
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            scout_calls.load(std::sync::atomic::Ordering::SeqCst),
            expected,
            "the second run did not call the scout again"
        );
    }
}

type Bodies = std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>;
/// Like `serve_by`, and it keeps every request body with who asked.
async fn serve_recording(
    reply: impl Fn(&str, &Value) -> String + Send + Sync + 'static,
) -> (u16, Bodies) {
    let bodies: Bodies = Default::default();
    let log = bodies.clone();
    let port = serve_by(move |who, body| {
        log.lock().unwrap().push((who.to_owned(), body.clone()));
        reply(who, body)
    })
    .await;
    (port, bodies)
}
fn last_role(body: &Value) -> &str {
    body["messages"]
        .as_array()
        .and_then(|m| m.last())
        .and_then(|m| m["role"].as_str())
        .unwrap_or("")
}
fn last_user(body: &Value) -> String {
    body["messages"]
        .as_array()
        .and_then(|m| m.iter().rev().find(|x| x["role"] == "user"))
        .and_then(|m| m["content"].as_str())
        .unwrap_or("")
        .to_owned()
}
async fn run_args(port: u16, home: &Path, extra: Vec<String>, task: &str) -> std::process::Output {
    let (h, task) = (home.to_owned(), task.to_owned());
    tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_hivecode"))
            .args(["run", "--headless", "--model", "fake", "--mode", "auto"])
            .args(&extra)
            .args(["--base-url", &format!("http://127.0.0.1:{port}/v1")])
            .arg(&task)
            .env("HIVECODE_API_KEY", "fake")
            .env("HIVE_HOME", &h)
            .env("TMPDIR", &h)
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}
fn done_of(out: &std::process::Output) -> Value {
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "stderr: {}\nstdout: {stdout}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_str(stdout.lines().last().unwrap()).unwrap()
}

#[tokio::test]
async fn a_resumed_run_continues_the_lead_conversation_on_the_same_project() {
    let (port, bodies) = serve_recording(|who, body| {
        if who != "other" && who != "BEE" && who != "Scout" && who != "Builder" {
            return answer("?");
        }
        if last_role(body) == "tool" {
            return answer(if last_user(body).contains("otro") {
                "otro hecho"
            } else {
                "hecho"
            });
        }
        if last_user(body).contains("agrega otro") {
            tool_call("fs_write", json!({"path":"otro.txt","content":"segundo\n"}))
        } else {
            tool_call(
                "fs_write",
                json!({"path":"nuevo.txt","content":"primero\n"}),
            )
        }
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let root = project.path().to_str().unwrap().to_owned();
    let first = done_of(
        &run_args(
            port,
            home.path(),
            vec!["--root".into(), root],
            "crea nuevo.txt",
        )
        .await,
    );
    let id = first["run_id"].as_str().unwrap().to_owned();

    // The second run names no project and no mode of its own beyond --mode: both come from the first.
    let second = done_of(
        &run_args(
            port,
            home.path(),
            vec!["--resume".into(), id.clone()],
            "agrega otro.txt",
        )
        .await,
    );
    assert_eq!(second["content"], "otro hecho");
    assert_ne!(second["run_id"], first["run_id"]);
    assert!(project.path().join("nuevo.txt").exists() && project.path().join("otro.txt").exists());

    let resumed_request = bodies
        .lock()
        .unwrap()
        .iter()
        .find(|(_, b)| last_user(b).contains("agrega otro"))
        .unwrap()
        .1
        .to_string();
    assert!(
        resumed_request.contains("crea nuevo.txt"),
        "the lead remembers the first run: {resumed_request}"
    );
    let runs: Value =
        serde_json::from_slice(&hivecode(home.path(), &["history", "--json"]).stdout).unwrap();
    assert_eq!(runs[0]["resumed_from"], id.as_str());
    assert_eq!(
        runs[0]["lead_session"],
        id.as_str(),
        "the conversation is the first run's"
    );
    assert_eq!(runs[1]["resumed_from"], Value::Null);
}

#[tokio::test]
async fn a_resumed_swarm_can_revise_a_worker_of_the_earlier_run_with_its_context() {
    let (port, bodies) = serve_recording(|who, body| match who {
        "BEE" => {
            if last_role(body) == "tool" {
                answer(if last_user(body).contains("FEEDBACK-91") {
                    "revisado"
                } else {
                    "listo"
                })
            } else if last_user(body).contains("FEEDBACK-91") {
                tool_call(
                    "task_revise",
                    json!({"task_id":"D1","feedback":"FEEDBACK-91 falta b.txt"}),
                )
            } else {
                tool_call(
                    "task_delegate",
                    json!({"worker_id":"scout","task_description":"revisa a.txt y resume"}),
                )
            }
        }
        _ => answer(if body.to_string().contains("FEEDBACK-91") {
            "CORREGIDO"
        } else {
            "primer informe"
        }),
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let root = project.path().to_str().unwrap().to_owned();
    let first = done_of(
        &run_args(
            port,
            home.path(),
            vec!["--swarm".into(), "--root".into(), root],
            "monta un equipo",
        )
        .await,
    );
    let id = first["run_id"].as_str().unwrap().to_owned();

    // --swarm is not repeated: the run says it used it, and the lead needs the same tools to reopen.
    let second = done_of(
        &run_args(
            port,
            home.path(),
            vec!["--resume".into(), id],
            "FEEDBACK-91 falta cubrir b.txt",
        )
        .await,
    );
    assert_eq!(second["content"], "revisado");
    let scout_requests: Vec<String> = bodies
        .lock()
        .unwrap()
        .iter()
        .filter(|(w, _)| w == "Scout")
        .map(|(_, b)| b.to_string())
        .collect();
    assert_eq!(
        scout_requests.len(),
        2,
        "one run and one revision, no new scout"
    );
    let revision = &scout_requests[1];
    assert!(
        revision.contains("revisa a.txt y resume")
            && revision.contains("primer informe")
            && revision.contains("FEEDBACK-91 falta b.txt"),
        "the scout resumed its own session after a restart: {revision}"
    );
}

#[tokio::test]
async fn resuming_fails_with_a_clear_reason_when_it_cannot_be_done() {
    let port = serve_by(|_, body| {
        if last_role(body) == "tool" {
            answer("hecho")
        } else {
            tool_call("fs_write", json!({"path":"x.txt","content":"x"}))
        }
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let root = project.path().to_str().unwrap().to_owned();
    let first =
        done_of(&run_args(port, home.path(), vec!["--root".into(), root], "crea x.txt").await);
    let id = first["run_id"].as_str().unwrap().to_owned();
    let message = |out: std::process::Output| {
        assert!(!out.status.success());
        String::from_utf8_lossy(&out.stderr).into_owned()
    };

    assert!(
        message(
            run_args(
                port,
                home.path(),
                vec!["--resume".into(), "run-nope".into()],
                "sigue"
            )
            .await
        )
        .contains("no existe la corrida")
    );
    assert!(
        message(
            run_args(
                port,
                home.path(),
                vec!["--resume".into(), id.clone(), "--swarm".into()],
                "sigue"
            )
            .await
        )
        .contains("sin --swarm")
    );
    // A different model would not reopen the lead's session: said in words, not as an SDK code.
    let (h, id2) = (home.path().to_owned(), id.clone());
    let out = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_hivecode"))
            .args([
                "run",
                "--headless",
                "--model",
                "otro-modelo",
                "--mode",
                "auto",
                "--resume",
                &id2,
            ])
            .args(["--base-url", &format!("http://127.0.0.1:{port}/v1")])
            .arg("sigue")
            .env("HIVECODE_API_KEY", "fake")
            .env("HIVE_HOME", &h)
            .env("TMPDIR", &h)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    assert!(message(out).contains("otras opciones"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_run_cut_mid_turn_is_listed_as_interrupted_and_recovered_with_the_work_it_had_done() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let (hang, hanging) = (
        std::sync::Arc::new(AtomicBool::new(true)),
        std::sync::Arc::new(AtomicBool::new(false)),
    );
    let (hang_flag, hanging_flag) = (hang.clone(), hanging.clone());
    let (port, bodies) = serve_recording(move |_, body| {
        if last_role(body) == "tool" {
            // The model call after the first tool result never answers: that is where the process is cut.
            hanging_flag.store(true, Ordering::SeqCst);
            // `block_in_place`: a plain sleep here would hold the worker that drives tokio's timers, and
            // the test's own `sleep` below would never wake.
            tokio::task::block_in_place(|| {
                while hang_flag.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            });
            return answer("no importa");
        }
        if last_user(body).contains("se interrumpió") {
            answer("retomado")
        } else {
            tool_call(
                "fs_write",
                json!({"path":"nuevo.txt","content":"hecho antes del corte\n"}),
            )
        }
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_hivecode"))
        .args([
            "run",
            "--headless",
            "--model",
            "fake",
            "--mode",
            "auto",
            "--root",
        ])
        .arg(project.path())
        .args([
            "--base-url",
            &format!("http://127.0.0.1:{port}/v1"),
            "crea nuevo.txt",
        ])
        .env("HIVECODE_API_KEY", "fake")
        .env("HIVE_HOME", home.path())
        .env("TMPDIR", home.path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    for _ in 0..500 {
        if hanging.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        hanging.load(Ordering::SeqCst),
        "the run reached the point where it is cut"
    );
    child.kill().unwrap();
    child.wait().unwrap();
    hang.store(false, Ordering::SeqCst);

    assert!(
        !project.path().join("nuevo.txt").exists(),
        "nothing was integrated: the run never finished"
    );
    let listed: Value =
        serde_json::from_slice(&hivecode(home.path(), &["history", "--json"]).stdout).unwrap();
    let id = listed[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        listed[0]["status"], "running",
        "a cut run stays recorded as running"
    );
    assert!(
        String::from_utf8_lossy(&hivecode(home.path(), &["history"]).stdout)
            .contains(&format!("--recover {id}"))
    );

    // It is the same thing the SDK refuses to continue by itself: an operation was in flight.
    let recovered =
        done_of(&run_args(port, home.path(), vec!["--recover".into(), id.clone()], "").await);
    assert_eq!(recovered["content"], "retomado");
    assert_eq!(recovered["integration"], "integrated");
    assert_eq!(
        std::fs::read_to_string(project.path().join("nuevo.txt")).unwrap(),
        "hecho antes del corte\n",
        "the work the interrupted run had done in its copy was kept and integrated"
    );

    let sent = bodies
        .lock()
        .unwrap()
        .iter()
        .find(|(_, b)| last_user(b).contains("se interrumpió"))
        .unwrap()
        .1
        .clone();
    let prompt = last_user(&sent);
    assert!(
        prompt.contains("Tarea original:\ncrea nuevo.txt") && prompt.contains("git_status"),
        "{prompt}"
    );
    let listed: Value =
        serde_json::from_slice(&hivecode(home.path(), &["history", "--json"]).stdout).unwrap();
    let by = |run: &str| {
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == run)
            .unwrap()
            .clone()
    };
    assert_eq!(by(&id)["status"], "abandoned");
    assert_eq!(listed[0]["resumed_from"], id.as_str());

    // A run that finished is not "interrupted": it is resumed, not recovered.
    let again = run_args(
        port,
        home.path(),
        vec![
            "--recover".into(),
            recovered["run_id"].as_str().unwrap().to_owned(),
        ],
        "",
    )
    .await;
    assert!(!again.status.success());
    assert!(String::from_utf8_lossy(&again.stderr).contains("no está interrumpida"));
}

/// Runs `hivecode` as the TUI server against `fake_tui.py` playing `steps`; returns every message the
/// fake TUI received. `extra` are hivecode flags.
async fn with_fake_tui(
    port: u16,
    home: &Path,
    project: &Path,
    steps: Value,
    extra: Vec<String>,
) -> (std::process::Output, Vec<Value>) {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fake_tui.py");
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_tui.py"),
        &script,
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let log = dir.path().join("log.json");
    let (home, project, log_path) = (home.to_owned(), project.to_owned(), log.clone());
    let out = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_hivecode"))
            .args(["--model", "fake", "--root"])
            .arg(&project)
            .args(["--base-url", &format!("http://127.0.0.1:{port}/v1")])
            .args(&extra)
            .env("HIVECODE_API_KEY", "fake")
            .env("HIVE_HOME", &home)
            .env("TMPDIR", &home)
            .env("HIVECODE_TUI_BIN", &script)
            .env("HIVECODE_SECRETS_FILE", home.join("secrets.json"))
            .env("FAKE_TUI_STEPS", steps.to_string())
            .env("FAKE_TUI_LOG", &log_path)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    let received: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(&log).unwrap_or_else(|_| "[]".into()))
            .unwrap();
    (out, received)
}
fn kinds(messages: &[Value], kind: &str) -> Vec<Value> {
    messages
        .iter()
        .filter(|m| m["type"] == kind)
        .map(|m| m["payload"].clone())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_tui_session_runs_a_task_and_shows_its_tools_text_and_result() {
    let port = serve_by(|_, body| {
        if last_role(body) == "tool" {
            answer("hecho")
        } else {
            tool_call(
                "fs_write",
                json!({"path":"nuevo.txt","content":"desde la TUI\n"}),
            )
        }
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let steps = json!([
        {"until": "init"},
        {"send": {"type": "submit", "input": "crea nuevo.txt"}},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "exit"}}
    ]);
    let (out, got) = with_fake_tui(
        port,
        home.path(),
        project.path(),
        steps,
        vec!["--mode".into(), "auto".into()],
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let init = &kinds(&got, "init")[0];
    assert_eq!(init["mode"], "auto");
    assert_eq!(
        init["project_name"],
        project.path().file_name().unwrap().to_str().unwrap()
    );
    assert!(
        init["workers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w == "bee")
    );
    let calls = kinds(&got, "tool_call");
    let dones = kinds(&got, "tool_done");
    assert_eq!(
        (calls[0]["tool"].as_str(), calls[0]["agent"].as_str()),
        (Some("fs_write"), Some("bee"))
    );
    assert_eq!(
        dones[0]["call_id"], calls[0]["call_id"],
        "a tool_call is always paired with its tool_done"
    );
    assert_eq!(dones[0]["ok"], true);
    let text: String = kinds(&got, "assistant_chunk")
        .iter()
        .map(|c| c["text"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(text, "hecho");
    assert_eq!(kinds(&got, "assistant_done").len(), 1);
    assert!(
        kinds(&got, "history_append")
            .iter()
            .any(|h| h["role"] == "user" && h["content"] == "crea nuevo.txt")
    );
    assert!(kinds(&got, "history_append").iter().any(|h| {
        h["content"]
            .as_str()
            .unwrap_or("")
            .contains("cambios: integrated")
    }));
    assert_eq!(
        std::fs::read_to_string(project.path().join("nuevo.txt")).unwrap(),
        "desde la TUI\n"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn approval_mode_asks_through_the_tui_and_the_answer_decides_and_the_second_task_remembers_the_first()
 {
    let (port, bodies) = serve_recording(|_, body| {
        if last_role(body) == "tool" {
            return answer("listo");
        }
        let wanted = if last_user(body).contains("segundo") {
            "dos.txt"
        } else {
            "uno.txt"
        };
        tool_call("fs_write", json!({"path": wanted, "content": "x\n"}))
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let steps = json!([
        {"until": "init"},
        {"send": {"type": "submit", "input": "crea el primero"}},
        {"approve": true},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "submit", "input": "crea el segundo"}},
        {"approve": false},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "exit"}}
    ]);
    let (out, got) = with_fake_tui(
        port,
        home.path(),
        project.path(),
        steps,
        vec!["--mode".into(), "approval".into()],
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let requests = kinds(&got, "tool_approval_request");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        (requests[0]["tool"].as_str(), requests[0]["kind"].as_str()),
        (Some("fs_write"), Some("tool"))
    );
    assert!(requests[0]["detail"].as_str().unwrap().contains("uno.txt"));
    assert_ne!(requests[0]["request_id"], requests[1]["request_id"]);
    assert!(project.path().join("uno.txt").exists(), "approved: it ran");
    assert!(
        !project.path().join("dos.txt").exists(),
        "declined: it did not"
    );
    let dones = kinds(&got, "tool_done");
    assert_eq!(
        (dones[0]["ok"].as_bool(), dones[1]["ok"].as_bool()),
        (Some(true), Some(false))
    );

    let second = bodies
        .lock()
        .unwrap()
        .iter()
        .find(|(_, b)| last_user(b).contains("segundo"))
        .unwrap()
        .1
        .to_string();
    assert!(
        second.contains("crea el primero"),
        "the second task resumed the first one's conversation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_mode_can_be_changed_from_the_tui_and_is_kept_for_the_next_session() {
    let port = serve_by(|_, _| answer("ok")).await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let steps = json!([
        {"until": "init"},
        {"send": {"type": "mode_change", "mode": "approval"}},
        {"until": "state_update", "where": {"new_mode": "approval"}},
        {"send": {"type": "submit", "input": "/mode plan"}},
        {"until": "state_update", "where": {"new_mode": "plan"}},
        {"send": {"type": "submit", "input": "/halt"}},
        {"until": "history_append", "where": {"content": "No hay una tarea en curso."}},
        {"send": {"type": "exit"}}
    ]);
    let (out, _) = with_fake_tui(
        port,
        home.path(),
        project.path(),
        steps,
        vec!["--mode".into(), "auto".into()],
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(home.path().join("execution_mode")).unwrap(),
        "plan"
    );
}

/// The real `hivetui` (headless, NDJSON frames) driven by keystrokes against the real server. Skipped
/// when the TUI has not been built: `cd packages/hivetui && cargo build`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_real_tui_shows_what_the_rust_server_sends_when_a_task_is_typed() {
    use std::io::{BufRead, Write};
    let tui =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/hivetui/target/debug/hivetui");
    if !tui.is_file() {
        eprintln!("skipped: packages/hivetui is not built");
        return;
    }
    let port = serve_by(|_, body| {
        if last_role(body) == "tool" {
            answer("LISTO-DESDE-EL-MODELO")
        } else {
            tool_call("fs_write", json!({"path":"real.txt","content":"x\n"}))
        }
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_hivecode"))
        .args(["--model", "fake", "--mode", "auto", "--root"])
        .arg(project.path())
        .args(["--base-url", &format!("http://127.0.0.1:{port}/v1")])
        .env("HIVECODE_API_KEY", "fake")
        .env("HIVE_HOME", home.path())
        .env("TMPDIR", home.path())
        .env("HIVECODE_TUI_BIN", &tui)
        .env("HIVETUI_HEADLESS", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let wait_for = |what: &str| -> String {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut last = String::new();
        while std::time::Instant::now() < deadline {
            if let Ok(frame) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                if frame.contains(what) {
                    return frame;
                }
                last = frame;
            }
        }
        panic!("the TUI never showed {what:?}; last frame: {last}");
    };
    // The welcome session arrives with `init`; then the person types a task and presses Enter.
    wait_for("\"frame\"");
    std::thread::sleep(std::time::Duration::from_millis(500));
    stdin.write_all("crea real.txt\r".as_bytes()).unwrap();
    stdin.flush().unwrap();
    let frame = wait_for("LISTO-DESDE-EL-MODELO");
    assert!(frame.contains("\"frame\""), "{frame}");
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        project.path().join("real.txt").exists(),
        "the task ran and was integrated"
    );
}

/// `hivecode <args>` with an isolated home, a key in the environment (so the real keyring is never
/// asked) and no provider variables.
fn tool(home: &Path, args: &[&str]) -> (bool, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_hivecode"))
        .args(args)
        .env("HIVE_HOME", home)
        .env("TMPDIR", home)
        .env("HIVECODE_API_KEY", "una-clave")
        .env_remove("HIVECODE_MODEL")
        .output()
        .unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn providers_are_managed_from_the_command_line_and_the_file_has_no_key() {
    let home = tempfile::tempdir().unwrap();
    let (ok, out, _) = tool(
        home.path(),
        &[
            "provider",
            "add",
            "nv",
            "--preset",
            "nvidia",
            "--model",
            "nvidia/nemotron",
            "--context-window",
            "100000",
        ],
    );
    assert!(ok && out.contains("activo"), "{out}");
    assert!(
        tool(
            home.path(),
            &[
                "provider",
                "add",
                "local",
                "--base-url",
                "http://127.0.0.1:1/v1",
                "--model",
                "qwen"
            ]
        )
        .0
    );
    let (_, list, _) = tool(home.path(), &["provider", "list"]);
    assert!(
        list.contains("● nv") && list.contains("nvidia/nemotron") && list.contains("local"),
        "{list}"
    );
    assert!(list.contains("clave en $HIVECODE_API_KEY"));
    assert!(tool(home.path(), &["provider", "use", "local"]).0);
    assert!(
        tool(home.path(), &["provider", "list"])
            .1
            .contains("● local")
    );

    let saved = std::fs::read_to_string(home.path().join("config.json")).unwrap();
    assert!(
        saved.contains("context_window") && !saved.contains("una-clave"),
        "no key in the file: {saved}"
    );
    let (ok, _, err) = tool(
        home.path(),
        &["provider", "add", "mal", "--preset", "no-existe"],
    );
    assert!(!ok && err.contains("preset desconocido"));
    assert!(
        !tool(home.path(), &["provider", "add", "otro"]).0,
        "neither a preset nor a URL"
    );
    assert!(
        tool(home.path(), &["provider", "presets"])
            .1
            .contains("nvidia")
    );
    assert!(tool(home.path(), &["provider", "remove", "local"]).0);
    assert!(!tool(home.path(), &["provider", "use", "local"]).0);
}

#[tokio::test]
async fn a_run_with_no_flags_uses_the_active_provider_of_the_config() {
    let port = serve(vec![answer("desde el proveedor configurado")]).await;
    let home = tempfile::tempdir().unwrap();
    let url = format!("http://127.0.0.1:{port}/v1");
    assert!(
        tool(
            home.path(),
            &[
                "provider",
                "add",
                "falso",
                "--base-url",
                &url,
                "--model",
                "fake",
                "--context-window",
                "50000"
            ]
        )
        .0
    );
    let project = repo();
    let (h, p) = (home.path().to_owned(), project.path().to_owned());
    let out = tokio::task::spawn_blocking(move || {
        tool(
            &h,
            &[
                "run",
                "--headless",
                "--mode",
                "plan",
                "--root",
                p.to_str().unwrap(),
                "hola",
            ],
        )
    })
    .await
    .unwrap();
    assert!(out.0, "{}", out.2);
    let done: Value = serde_json::from_str(out.1.lines().last().unwrap()).unwrap();
    assert_eq!(done["content"], "desde el proveedor configurado");

    // Without any provider the run says what to do instead of failing obscurely.
    let empty = tempfile::tempdir().unwrap();
    let (ok, _, err) = tool(empty.path(), &["run", "--mode", "plan", "hola"]);
    assert!(!ok && err.contains("hivecode provider add"), "{err}");
}

#[test]
fn mcp_servers_are_managed_from_the_command_line() {
    let home = tempfile::tempdir().unwrap();
    assert!(
        tool(
            home.path(),
            &[
                "mcp",
                "add",
                "docs",
                "--command",
                "servidor-docs",
                "--arg",
                "--raiz",
                "--arg",
                "/x",
                "--env",
                "TOKEN=${DOCS_TOKEN}"
            ]
        )
        .0
    );
    assert!(
        tool(
            home.path(),
            &[
                "mcp",
                "add",
                "web",
                "--url",
                "https://s.example/mcp",
                "--header",
                "Authorization=Bearer ${T}"
            ]
        )
        .0
    );
    assert!(tool(home.path(), &["mcp", "disable", "web"]).0);
    let (_, list, _) = tool(home.path(), &["mcp", "list"]);
    assert!(
        list.contains("● docs")
            && list.contains("servidor-docs --raiz /x")
            && list.contains("○ web"),
        "{list}"
    );
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(home.path().join("mcp.json")).unwrap())
            .unwrap();
    assert_eq!(file["servers"]["docs"]["env"]["TOKEN"], "${DOCS_TOKEN}");
    assert!(
        !tool(home.path(), &["mcp", "add", "x"]).0,
        "needs --command or --url"
    );
    assert!(!tool(home.path(), &["mcp", "add", "a__b", "--command", "c"]).0);
    assert!(tool(home.path(), &["mcp", "remove", "docs"]).0);
    assert!(!tool(home.path(), &["mcp", "remove", "docs"]).0);
}

#[test]
fn doctor_reports_what_is_ready_and_fails_when_something_needed_is_missing() {
    let home = tempfile::tempdir().unwrap();
    let (ok, out, _) = tool(home.path(), &["doctor"]);
    assert!(!ok, "no provider: {out}");
    assert!(
        out.contains("✓ git")
            && out.contains("✓ base de datos")
            && out.contains("✗ proveedor")
            && out.contains("hivecode provider add"),
        "{out}"
    );

    assert!(
        tool(
            home.path(),
            &[
                "provider", "add", "nv", "--preset", "nvidia", "--model", "m"
            ]
        )
        .0
    );
    let (ok, out, err) = tool(home.path(), &["doctor"]);
    assert!(ok, "{out}{err}");
    assert!(
        out.contains("✓ proveedor")
            && out.contains("nv (clave en $HIVECODE_API_KEY)")
            && out.contains("Todo lo necesario está listo"),
        "{out}"
    );
}

#[test]
fn init_describes_the_project_and_writes_the_detected_checks_only_when_asked_and_never_over_a_file()
{
    let project = repo();
    std::fs::write(project.path().join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
    std::fs::create_dir_all(project.path().join("tests")).unwrap();
    std::fs::write(project.path().join("tests/a.rs"), "#[test] fn t() {}\n").unwrap();
    std::fs::write(project.path().join("lib.rs"), "pub fn algo() {}\n").unwrap();
    let home = tempfile::tempdir().unwrap();
    let root = project.path().to_str().unwrap();

    let (ok, out, _) = tool(home.path(), &["init", "--root", root]);
    assert!(
        ok && out.contains("repositorio git con commits")
            && out.contains("ecosistemas: rust")
            && out.contains("`cargo test`"),
        "{out}"
    );
    assert!(
        !project.path().join(".hivecode/verify.json").exists(),
        "nothing is written unless asked"
    );

    assert!(tool(home.path(), &["init", "--root", root, "--write"]).0);
    let written: Value = serde_json::from_str(
        &std::fs::read_to_string(project.path().join(".hivecode/verify.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(written["test"], "cargo test");
    assert_eq!(written["build"], "cargo build");
    std::fs::write(
        project.path().join(".hivecode/verify.json"),
        r#"{"test":"make mio"}"#,
    )
    .unwrap();
    let (_, again, _) = tool(home.path(), &["init", "--root", root, "--write"]);
    assert!(again.contains("no se toca"), "{again}");
    assert_eq!(
        std::fs::read_to_string(project.path().join(".hivecode/verify.json")).unwrap(),
        r#"{"test":"make mio"}"#
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changing_a_file_an_accepted_decision_covers_is_flagged_after_the_run_and_in_the_tui() {
    let port = serve_by(|_, body| {
        if last_role(body) == "tool" {
            answer("hecho")
        } else {
            tool_call(
                "fs_write",
                json!({"path":"src/auth/login.ts","content":"export const x = 1\n"}),
            )
        }
    })
    .await;
    let project = repo();
    // `fs_write` does not create folders: the project already has `src/auth`.
    std::fs::create_dir_all(project.path().join("src/auth")).unwrap();
    std::fs::write(project.path().join("src/auth/index.ts"), "export {}\n").unwrap();
    std::fs::create_dir(project.path().join("adrs")).unwrap();
    std::fs::write(
        project.path().join("adrs/0001.md"),
        "# Autenticación\n\n**Status**: accepted\nLos permisos viven en la carpeta auth.\n",
    )
    .unwrap();
    let home = tempfile::tempdir().unwrap();

    let (p, h) = (project.path().to_owned(), home.path().to_owned());
    let done = tokio::task::spawn_blocking(move || run(port, &p, &h, "auto", "crea el login"))
        .await
        .unwrap();
    assert_eq!(done["risks"][0]["path"], "src/auth/login.ts", "{done}");
    assert_eq!(done["risks"][0]["risk"], "high");
    assert!(
        done["risks"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("Autenticación")
    );

    // The TUI gets the same thing as a file_risk_update.
    std::fs::remove_file(project.path().join("src/auth/login.ts")).unwrap();
    let steps = json!([
        {"until": "init"}, {"send": {"type": "submit", "input": "crea el login otra vez"}},
        {"until": "status", "where": {"running": false, "msg": "Listo"}}, {"send": {"type": "exit"}}
    ]);
    let (out, got) = with_fake_tui(
        port,
        home.path(),
        project.path(),
        steps,
        vec!["--mode".into(), "auto".into()],
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let risks = kinds(&got, "file_risk_update");
    assert_eq!(
        (risks[0]["path"].as_str(), risks[0]["risk"].as_str()),
        (Some("src/auth/login.ts"), Some("high"))
    );
    assert_eq!(risks[0]["agent"], "bee");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_settings_hub_lists_edits_and_refreshes_providers_and_mcp_servers() {
    let port = serve_by(|_, _| answer("ok")).await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let steps = json!([
        {"until": "init"},
        {"send": {"type": "request_settings"}},
        {"until": "settings_data"},
        {"send": {"type": "submit", "input": "/provider add"}},
        {"until": "show_config_modal", "where": {"command": "provider_add"}},
        {"send": {"type": "modal_submit", "command": "provider_add", "values": {"name": "nv", "preset": "nvidia", "model": "nvidia/nemotron", "context_window": "100000", "api_key": "clave-secreta-1"}}},
        {"until": "settings_data", "where": {"github_connected": false}},
        {"send": {"type": "modal_submit", "command": "provider_add", "values": {"name": "malo", "preset": "no-existe", "model": "m"}}},
        {"until": "history_append", "where": {"content": "(×ᴗ×) catálogo desconocido `no-existe`"}},
        {"send": {"type": "provider_activate", "provider_id": "nv", "api_key": "clave-nueva"}},
        {"until": "history_append", "where": {"content": "Proveedor activo: nv."}},
        {"send": {"type": "submit", "input": "/mcp add"}},
        {"until": "show_config_modal", "where": {"command": "mcp_add"}},
        {"send": {"type": "modal_submit", "command": "mcp_add", "values": {"name": "docs", "command": "servidor-docs", "args": "--raiz /x"}}},
        {"until": "history_append", "where": {"content": "Servidor MCP `docs` guardado."}},
        {"send": {"type": "submit", "input": "/mcp disable docs"}},
        {"until": "history_append", "where": {"content": "MCP `docs`: desactivado."}},
        {"send": {"type": "submit", "input": "/mcp inspect docs"}},
        {"until": "show_info_modal", "where": {"title": "MCP docs"}},
        {"send": {"type": "submit", "input": "/skill list"}},
        {"until": "history_append", "where": {"content": "/skill no está disponible en la versión Rust."}},
        {"send": {"type": "submit", "input": "/provider remove nv"}},
        {"until": "history_append", "where": {"content": "Proveedor `nv` eliminado."}},
        {"send": {"type": "exit"}}
    ]);
    let (out, got) = with_fake_tui(
        port,
        home.path(),
        project.path(),
        steps,
        vec!["--mode".into(), "plan".into()],
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let hubs = kinds(&got, "settings_data");
    assert!(
        hubs[0]["providers"].as_array().unwrap().is_empty(),
        "nothing configured yet"
    );
    let agents: Vec<&str> = hubs[0]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(agents, ["bee", "scout", "builder", "verifier", "spider"]);
    let added = hubs[1]["providers"][0].clone();
    assert_eq!(
        (
            added["id"].as_str(),
            added["model"].as_str(),
            added["is_active"].as_bool(),
            added["has_key"].as_bool()
        ),
        (Some("nv"), Some("nvidia/nemotron"), Some(true), Some(true))
    );
    let modal = kinds(&got, "show_config_modal")[0].clone();
    let preset = modal["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["key"] == "preset")
        .unwrap();
    assert_eq!(preset["field_type"], "select");
    assert!(
        preset["options"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o == "nvidia")
    );
    assert!(
        modal["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["key"] == "api_key" && f["secret"] == true)
    );
    let mcp_hub = hubs
        .iter()
        .find(|h| h["mcp"].as_array().is_some_and(|m| !m.is_empty()))
        .unwrap();
    assert_eq!(mcp_hub["mcp"][0]["url"], "servidor-docs --raiz /x");
    let disabled = hubs
        .iter()
        .rev()
        .find(|h| h["mcp"].as_array().is_some_and(|m| !m.is_empty()))
        .unwrap();
    assert_eq!(disabled["mcp"][0]["enabled"], false);
    // `settings_data` follows the confirmation line, and the fake leaves at the line: the files say it.
    let config: Value =
        serde_json::from_str(&std::fs::read_to_string(home.path().join("config.json")).unwrap())
            .unwrap();
    assert!(
        config["providers"].as_object().unwrap().is_empty(),
        "removed again: {config}"
    );
    assert!(
        !config.to_string().contains("clave"),
        "no key in the config file"
    );

    // The typed key went to the secrets file (only the owner reads it), the new one replaced it, and
    // removing the provider removed it.
    let secrets = std::fs::read_to_string(home.path().join("secrets.json")).unwrap();
    assert!(
        !secrets.contains("clave-secreta-1") && !secrets.contains("clave-nueva"),
        "{secrets}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plan_made_in_plan_mode_waits_for_approval_and_each_answer_does_what_it_says() {
    let (port, bodies) = serve_recording(|_, body| {
        if last_role(body) == "tool" {
            return answer("listo");
        }
        let user = last_user(body);
        if user.contains("Plan aprobado") || user.contains("Contexto adicional") {
            tool_call("fs_write", json!({"path":"arreglo.txt","content":"x\n"}))
        } else {
            answer("1. leer el login\n2. corregirlo")
        }
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let flags = vec!["--swarm".to_owned(), "--mode".to_owned(), "plan".to_owned()];

    // Approve: the plan runs in auto mode, once.
    let steps = json!([
        {"until": "init"},
        {"send": {"type": "submit", "input": "corrige el bug del login"}},
        {"until": "plan_approval_request"},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "submit", "input": "/approve auto"}},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "submit", "input": "/approve auto"}},
        {"until": "history_append", "where": {"content": "No hay un plan pendiente."}},
        {"send": {"type": "exit"}}
    ]);
    let (out, _) = with_fake_tui(port, home.path(), project.path(), steps, flags.clone()).await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(project.path().join("arreglo.txt")).unwrap(),
        "x\n",
        "the approved plan ran and was integrated"
    );
    std::fs::remove_file(project.path().join("arreglo.txt")).unwrap();
    assert!(
        bodies
            .lock()
            .unwrap()
            .iter()
            .any(|(_, b)| last_user(b).contains("Tarea original:\ncorrige el bug del login"))
    );

    // Reject: nothing runs.
    let steps = json!([
        {"until": "init"},
        {"send": {"type": "submit", "input": "corrige el bug del login"}},
        {"until": "plan_approval_request"},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "submit", "input": "/reject"}},
        {"until": "history_append", "where": {"content": "Plan descartado."}},
        {"send": {"type": "exit"}}
    ]);
    let (out, _) = with_fake_tui(port, home.path(), project.path(), steps, flags.clone()).await;
    assert!(out.status.success());
    assert!(!project.path().join("arreglo.txt").exists());

    // Context: the next text is added to the plan and it runs in auto mode.
    let steps = json!([
        {"until": "init"},
        {"send": {"type": "submit", "input": "corrige el bug del login"}},
        {"until": "plan_approval_request"},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "submit", "input": "usa el módulo auth"}},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "exit"}}
    ]);
    let (out, _) = with_fake_tui(port, home.path(), project.path(), steps, flags).await;
    assert!(out.status.success());
    assert!(
        project.path().join("arreglo.txt").exists(),
        "the plan with its context ran"
    );
    assert!(bodies.lock().unwrap().iter().any(|(_, b)| {
        last_user(b).contains("Contexto adicional de la persona: usa el módulo auth")
    }));
}

/// The real `hivetui`: F2 opens the settings hub and it shows what the Rust server holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_real_tui_settings_hub_shows_the_providers_and_mcp_servers_of_the_rust_side() {
    use std::io::{BufRead, Write};
    let tui =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/hivetui/target/debug/hivetui");
    if !tui.is_file() {
        eprintln!("skipped: packages/hivetui is not built");
        return;
    }
    let home = tempfile::tempdir().unwrap();
    assert!(
        tool(
            home.path(),
            &[
                "provider",
                "add",
                "mi-proveedor",
                "--preset",
                "nvidia",
                "--model",
                "modelo-de-prueba"
            ]
        )
        .0
    );
    assert!(
        tool(
            home.path(),
            &["mcp", "add", "mi-mcp", "--command", "servidor-x"]
        )
        .0
    );
    let project = repo();
    let mut child = Command::new(env!("CARGO_BIN_EXE_hivecode"))
        .args(["--mode", "plan", "--root"])
        .arg(project.path())
        .env("HIVE_HOME", home.path())
        .env("TMPDIR", home.path())
        .env("HIVECODE_API_KEY", "x")
        .env("HIVECODE_TUI_BIN", &tui)
        .env("HIVETUI_HEADLESS", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let wait_for = |what: &str| -> String {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut last = String::new();
        while std::time::Instant::now() < deadline {
            if let Ok(frame) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                if frame.contains(what) {
                    return frame;
                }
                last = frame;
            }
        }
        panic!("the TUI never showed {what:?}; last frame: {last}");
    };
    wait_for("\"frame\"");
    std::thread::sleep(std::time::Duration::from_millis(500));
    stdin.write_all(b"\x1bOQ").unwrap(); // F2
    stdin.flush().unwrap();
    wait_for("mi-proveedor");
    // The MCP tab is next to the providers one; Tab moves across the tabs.
    for _ in 0..3 {
        stdin.write_all(b"\t").unwrap();
        stdin.flush().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    wait_for("mi-mcp");
    let _ = child.kill();
    let _ = child.wait();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_hive_gets_real_relations_waits_and_worker_states_from_the_swarm() {
    let port = serve_by(|who, body| {
        let tool_last = last_role(body) == "tool";
        match (who, tool_last) {
            ("BEE", false) => tool_call("task_delegate_group", json!({"tasks":[
                {"worker_id":"scout","task_description":"explora el proyecto","ref":"S"},
                {"worker_id":"builder","task_description":"crea equipo.txt","ref":"B","after":["S"]}]})),
            ("BEE", true) => answer("listo"),
            ("Builder", false) => tool_call("fs_write", json!({"path":"equipo.txt","content":"x\n"})),
            ("Builder", true) => answer("construido"),
            _ => answer("informe del scout"),
        }
    }).await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let steps = json!([
        {"until": "init"},
        {"send": {"type": "submit", "input": "monta un equipo"}},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "exit"}}
    ]);
    let (out, got) = with_fake_tui(
        port,
        home.path(),
        project.path(),
        steps,
        vec!["--swarm".into(), "--mode".into(), "auto".into()],
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let relations = kinds(&got, "swarm_collaboration");
    let of = |to: &str, kind: &str| {
        relations
            .iter()
            .find(|r| r["to"] == to && r["kind"] == kind)
            .unwrap_or_else(|| panic!("no {kind} for {to}: {relations:?}"))
            .clone()
    };
    let (scout_start, scout_end) = (of("scout", "delegation"), of("scout", "handoff"));
    assert_eq!(scout_start["from"], "bee");
    assert_eq!(
        scout_start["delegation_id"], scout_end["delegation_id"],
        "one delegation, from start to handoff"
    );
    assert_ne!(
        scout_start["event_id"], scout_end["event_id"],
        "each event has its own id: the TUI drops repeats"
    );
    assert_eq!(scout_start["summary"], "explora el proyecto");
    let builder_start = of("builder", "delegation");
    let position = |value: &Value| relations.iter().position(|r| r == value).unwrap();
    assert!(
        position(&scout_end) < position(&builder_start),
        "the builder was delegated to only after the scout's handoff"
    );
    of("builder", "handoff");

    let waits = kinds(&got, "esperando");
    assert_eq!(
        (waits[0]["agent"].as_str(), waits[0]["razon"].as_str()),
        (Some("builder"), Some("dependencia"))
    );
    assert_eq!(waits[0]["esperando_a"], json!(["S"]));

    let updates = kinds(&got, "worker_update");
    let states = |worker: &str| -> Vec<(String, String)> {
        updates
            .iter()
            .filter(|u| u["worker"] == worker)
            .map(|u| {
                (
                    u["phase"].as_str().unwrap().to_owned(),
                    u["status"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    let scout = states("scout");
    assert_eq!(scout.first().unwrap().1, "running");
    assert_eq!(
        scout.last().unwrap(),
        &("done".to_owned(), "done".to_owned())
    );
    assert!(
        states("builder")
            .iter()
            .any(|(phase, status)| phase == "writing" && status == "running"),
        "fs_write is `writing`: {:?}",
        states("builder")
    );
    assert!(
        updates
            .iter()
            .filter(|u| u["worker"] != "bee")
            .all(|u| u["parent_id"] == "bee"),
        "every worker hangs from the lead"
    );
    assert!(
        states("bee").iter().any(|(phase, _)| phase == "thinking"),
        "the lead delegating is `thinking`: {:?}",
        states("bee")
    );
}

/// The real `hivetui`: after a delegation the swarm view names the workers the Rust side delegated to.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_real_tui_draws_the_workers_the_lead_delegated_to() {
    use std::io::{BufRead, Write};
    let tui =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/hivetui/target/debug/hivetui");
    if !tui.is_file() {
        eprintln!("skipped: packages/hivetui is not built");
        return;
    }
    let port = serve_by(|who, body| match (who, last_role(body) == "tool") {
        ("BEE", false) => tool_call(
            "task_delegate",
            json!({"worker_id":"scout","task_description":"explora el proyecto"}),
        ),
        ("BEE", true) => answer("FIN-DEL-EQUIPO"),
        _ => answer("informe"),
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_hivecode"))
        .args(["--swarm", "--model", "fake", "--mode", "auto", "--root"])
        .arg(project.path())
        .args(["--base-url", &format!("http://127.0.0.1:{port}/v1")])
        .env("HIVE_HOME", home.path())
        .env("TMPDIR", home.path())
        .env("HIVECODE_API_KEY", "x")
        .env("HIVECODE_TUI_BIN", &tui)
        .env("HIVETUI_HEADLESS", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let wait_for = |what: &str| -> String {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut last = String::new();
        while std::time::Instant::now() < deadline {
            if let Ok(frame) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                if frame.to_lowercase().contains(&what.to_lowercase()) {
                    return frame;
                }
                last = frame;
            }
        }
        panic!("the TUI never showed {what:?}; last frame: {last}");
    };
    wait_for("\"frame\"");
    std::thread::sleep(std::time::Duration::from_millis(500));
    stdin.write_all("monta un equipo\r".as_bytes()).unwrap();
    stdin.flush().unwrap();
    wait_for("FIN-DEL-EQUIPO");
    // Key `1` (empty input) pins the swarm view, which draws the hive.
    stdin.write_all(b"1").unwrap();
    stdin.flush().unwrap();
    let frame = wait_for("scout");
    assert!(
        frame.contains("\"tab\":\"enjambre\"") || frame.to_lowercase().contains("enjambre"),
        "{frame}"
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_tui_lists_restore_points_for_runs_and_undoes_one_when_asked() {
    let port = serve_by(|_, body| {
        if last_role(body) == "tool" {
            answer("hecho")
        } else {
            tool_call("fs_write", json!({"path":"nuevo.txt","content":"x\n"}))
        }
    })
    .await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    // A run from before: its restore point is announced when the TUI starts.
    let before = done_of(
        &run_args(
            port,
            home.path(),
            vec!["--root".into(), project.path().to_str().unwrap().into()],
            "crea nuevo.txt",
        )
        .await,
    );
    let earlier = before["run_id"].as_str().unwrap().to_owned();
    std::fs::remove_file(project.path().join("nuevo.txt")).unwrap(); // so the next run has something to add

    let steps = json!([
        {"until": "init"},
        {"until": "checkpoint_created", "where": {"checkpoint_id": earlier}},
        {"send": {"type": "submit", "input": "crea nuevo.txt otra vez"}},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "rollback", "checkpoint_id": "no-existe"}},
        {"until": "history_append", "where": {"content": "(×ᴗ×) no existe la corrida no-existe"}},
        {"send": {"type": "exit"}}
    ]);
    let (out, got) = with_fake_tui(
        port,
        home.path(),
        project.path(),
        steps,
        vec!["--mode".into(), "auto".into()],
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let points = kinds(&got, "checkpoint_created");
    assert_eq!(points[0]["checkpoint_id"], earlier.as_str());
    assert_eq!(points[0]["description"], "crea nuevo.txt");
    assert_eq!(points[0]["file_count"], 1);
    let new_run = points
        .iter()
        .find(|p| p["checkpoint_id"] != earlier.as_str())
        .expect("the run just made becomes a restore point");
    assert_eq!(new_run["description"], "crea nuevo.txt otra vez");
    assert!(project.path().join("nuevo.txt").exists());

    // Undo the run the TUI just made, from a second session (a TUI that asks for it by id).
    let id = new_run["checkpoint_id"].as_str().unwrap().to_owned();
    let steps = json!([
        {"until": "init"},
        {"send": {"type": "rollback", "checkpoint_id": id}},
        {"until": "checkpoint_rollback", "where": {"checkpoint_id": id, "files_restored": 1}},
        {"send": {"type": "rollback", "checkpoint_id": id}},
        {"until": "history_append", "where": {"content": format!("(×ᴗ×) la corrida {id} ya se deshizo")}},
        {"send": {"type": "exit"}}
    ]);
    let (out, _) = with_fake_tui(
        port,
        home.path(),
        project.path(),
        steps,
        vec!["--mode".into(), "auto".into()],
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !project.path().join("nuevo.txt").exists(),
        "the undone run's file is gone"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cut_run_shows_the_resume_badge_and_task_resume_recovers_it() {
    let (port, bodies) = serve_recording(|_, _| answer("retomado")).await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    // A run that was cut: recorded as running, never finished.
    {
        let store = hivecode_store::Store::open(&home.path().join("data/rust")).unwrap();
        store
            .record_run(&hivecode_store::RunDoc {
                id: "run-0000000000001-1".into(),
                lead_session: "run-0000000000001-1".into(),
                project: project.path().display().to_string(),
                objective: "tarea cortada".into(),
                mode: "plan".into(),
                status: "running".into(),
                ..Default::default()
            })
            .unwrap();
    }
    let steps = json!([
        {"until": "init"},
        {"until": "resume_available", "where": {"task_id": "run-0000000000001-1"}},
        {"send": {"type": "task_resume", "task_id": "run-0000000000001-1"}},
        {"until": "history_append", "where": {"content": "Retomando la corrida run-0000000000001-1…"}},
        {"until": "status", "where": {"running": false, "msg": "Listo"}},
        {"send": {"type": "exit"}}
    ]);
    let (out, got) = with_fake_tui(
        port,
        home.path(),
        project.path(),
        steps,
        vec!["--mode".into(), "plan".into()],
    )
    .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        kinds(&got, "resume_available")[0]["checkpoint_id"],
        "run-0000000000001-1"
    );
    let sent = bodies
        .lock()
        .unwrap()
        .iter()
        .find(|(_, b)| last_user(b).contains("se interrumpió"))
        .unwrap()
        .1
        .clone();
    assert!(
        last_user(&sent).contains("Tarea original:\ntarea cortada"),
        "the interrupted run's own task is redone"
    );
    let runs: Value =
        serde_json::from_slice(&hivecode(home.path(), &["history", "--json"]).stdout).unwrap();
    let by = |id: &str| {
        runs.as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(by("run-0000000000001-1")["status"], "abandoned");
    assert_eq!(runs[0]["resumed_from"], "run-0000000000001-1");
}

/// Like `tool`, with lines on the standard input and a secrets file, so the real keyring is never touched.
fn tool_in(home: &Path, args: &[&str], input: &str) -> (bool, String, String) {
    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_hivecode"))
        .args(args)
        .env("HIVE_HOME", home)
        .env("TMPDIR", home)
        .env("HIVECODE_SECRETS_FILE", home.join("secrets.json"))
        .env_remove("HIVECODE_API_KEY")
        .env_remove("HIVECODE_MODEL")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn mcp_test_connects_for_a_moment_and_lists_the_tools_or_says_why_it_could_not() {
    let peer =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../hivecode-tools/tests/fixtures/mcp_peer.py");
    let peer = peer.to_str().unwrap();
    let home = tempfile::tempdir().unwrap();
    assert!(
        tool(
            home.path(),
            &[
                "mcp",
                "add",
                "peer",
                "--command",
                "python3",
                "--arg",
                peer,
                "--arg",
                "normal"
            ]
        )
        .0
    );
    let (ok, out, err) = tool(home.path(), &["mcp", "test", "peer"]);
    assert!(ok, "{err}");
    assert!(
        out.contains("✓ peer conectado")
            && out.contains("1 herramientas")
            && out.contains("add — Add two integers"),
        "{out}"
    );

    // A server that is switched off can still be tested: that is how one checks it before switching it on.
    assert!(tool(home.path(), &["mcp", "disable", "peer"]).0);
    assert!(tool(home.path(), &["mcp", "test", "peer"]).0);

    assert!(
        tool(
            home.path(),
            &["mcp", "add", "roto", "--command", "/no/existe/mcp"]
        )
        .0
    );
    let (ok, _, err) = tool(home.path(), &["mcp", "test", "roto"]);
    assert!(!ok && err.contains("roto no conectó"), "{err}");
    let (ok, _, err) = tool(home.path(), &["mcp", "test", "nada"]);
    assert!(!ok && err.contains("no hay servidor MCP `nada`"), "{err}");
    assert!(!tool(home.path(), &["mcp", "test"]).0, "needs a name");
}

#[test]
fn onboard_saves_an_active_provider_and_its_key_and_refuses_what_cannot_work() {
    let home = tempfile::tempdir().unwrap();
    let (ok, out, err) = tool_in(
        home.path(),
        &["onboard"],
        "nvidia\nnv\nnvidia/nemotron\n100000\nclave-del-asistente\n",
    );
    assert!(ok, "{err}");
    assert!(
        err.contains("Catálogo de proveedores:") && err.contains("nvidia"),
        "the catalog is shown: {err}"
    );
    assert!(
        out.contains("Proveedor `nv` guardado y activo") && out.contains("Clave guardada"),
        "{out}"
    );
    let config: Value =
        serde_json::from_str(&std::fs::read_to_string(home.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(config["active"], "nv");
    assert_eq!(
        (
            config["providers"]["nv"]["preset"].as_str(),
            config["providers"]["nv"]["model"].as_str(),
            config["providers"]["nv"]["context_window"].as_u64()
        ),
        (Some("nvidia"), Some("nvidia/nemotron"), Some(100_000))
    );
    assert!(
        !config.to_string().contains("clave-del-asistente"),
        "the key is not in the config file"
    );
    assert!(
        std::fs::read_to_string(home.path().join("secrets.json"))
            .unwrap()
            .contains("clave-del-asistente")
    );

    // Defaults: the name is the catalog id, and a missing key is said, not invented.
    let other = tempfile::tempdir().unwrap();
    let (ok, out, _) = tool_in(other.path(), &["onboard"], "openrouter\n\nmodelo-x\n\n\n");
    assert!(
        ok && out.contains("Proveedor `openrouter` guardado y activo")
            && out.contains("Falta la clave"),
        "{out}"
    );

    // A custom URL instead of the catalog.
    let url = tempfile::tempdir().unwrap();
    let (ok, out, _) = tool_in(
        url.path(),
        &["onboard"],
        "\nhttp://127.0.0.1:11434/v1\n\nqwen\n\n\n",
    );
    assert!(ok && out.contains("Proveedor `local` guardado"), "{out}");

    let bad = tempfile::tempdir().unwrap();
    for (input, expected) in [
        ("no-existe\n", "no está en el catálogo"),
        ("\n\n", "hace falta un proveedor del catálogo o una URL"),
        ("nvidia\n\n\n", "hace falta el modelo"),
        (
            "nvidia\n\nm\nmucho\n",
            "la ventana de contexto es un número",
        ),
    ] {
        let (ok, _, err) = tool_in(bad.path(), &["onboard"], input);
        assert!(!ok && err.contains(expected), "{input:?} → {err}");
    }
    assert!(
        !bad.path().join("config.json").exists(),
        "a refused wizard saves nothing"
    );
}

/// `hivecode cron ...` whose child runs reach the fake model at `port`.
fn cron(home: &Path, port: u16, args: &[&str]) -> (bool, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_hivecode"))
        .args(args)
        .env("HIVE_HOME", home)
        .env("TMPDIR", home)
        .env("HIVECODE_API_KEY", "x")
        .env("HIVECODE_MODEL", "fake")
        .env("HIVECODE_BASE_URL", format!("http://127.0.0.1:{port}/v1"))
        .output()
        .unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn scheduled_tasks_are_added_listed_and_refused_when_they_cannot_work() {
    let home = tempfile::tempdir().unwrap();
    let project = repo();
    let root = project.path().to_str().unwrap();
    let (ok, out, err) = cron(
        home.path(),
        1,
        &[
            "cron",
            "add",
            "diaria",
            "--cron",
            "0 8 * * MON-FRI",
            "--tz",
            "America/Bogota",
            "--task",
            "revisa el proyecto",
            "--root",
            root,
            "--mode",
            "plan",
        ],
    );
    assert!(ok, "{err}");
    assert!(
        out.contains("Tarea `diaria` programada; próxima ejecución:") && out.contains("Z."),
        "{out}"
    );
    let (_, list, _) = cron(home.path(), 1, &["cron", "list"]);
    assert!(
        list.contains("● diaria")
            && list.contains("active")
            && list.contains("cron 0 8 * * MON-FRI (America/Bogota)")
            && list.contains("revisa el proyecto"),
        "{list}"
    );

    // The same definition again is the same task; another one under the same name is refused.
    assert!(
        cron(
            home.path(),
            1,
            &[
                "cron",
                "add",
                "diaria",
                "--cron",
                "0 8 * * MON-FRI",
                "--tz",
                "America/Bogota",
                "--task",
                "revisa el proyecto",
                "--root",
                root,
                "--mode",
                "plan"
            ]
        )
        .0
    );
    let (ok, _, err) = cron(
        home.path(),
        1,
        &[
            "cron",
            "add",
            "diaria",
            "--cron",
            "0 9 * * *",
            "--task",
            "otra cosa",
            "--root",
            root,
        ],
    );
    assert!(!ok && err.contains("las programadas no se editan"), "{err}");

    for (args, expected) in [
        (
            vec![
                "cron",
                "add",
                "a",
                "--cron",
                "0 8 * * *",
                "--task",
                "x",
                "--mode",
                "approval",
            ],
            "approval",
        ),
        (
            vec![
                "cron",
                "add",
                "b",
                "--cron",
                "esto no es cron",
                "--task",
                "x",
            ],
            "cron",
        ),
        (
            vec!["cron", "add", "c", "--task", "x"],
            "--cron o --every-seconds",
        ),
        (vec!["cron", "add", "d", "--cron", "0 8 * * *"], "uso:"),
        (
            vec![
                "cron",
                "add",
                "e",
                "--cron",
                "0 8 * * *",
                "--task",
                "x",
                "--every-seconds",
                "5",
            ],
            "--cron o --every-seconds",
        ),
        (vec!["cron", "enable", "nada"], "SCHEDULE_NOT_FOUND"),
    ] {
        let (ok, _, err) = cron(home.path(), 1, &args);
        assert!(!ok && err.contains(expected), "{args:?} → {err}");
    }
    assert!(cron(home.path(), 1, &["cron", "disable", "diaria"]).0);
    assert!(
        cron(home.path(), 1, &["cron", "list"])
            .1
            .contains("○ diaria")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_due_scheduled_task_runs_as_a_normal_run_and_a_disabled_one_does_not() {
    let port = serve_by(|_, _| answer("tarea programada hecha")).await;
    let project = repo();
    let home = tempfile::tempdir().unwrap();
    let root = project.path().to_str().unwrap().to_owned();
    let (h, r) = (home.path().to_owned(), root.clone());
    let out = tokio::task::spawn_blocking(move || {
        assert!(
            cron(
                &h,
                port,
                &[
                    "cron",
                    "add",
                    "rapida",
                    "--every-seconds",
                    "1",
                    "--task",
                    "hola desde cron",
                    "--root",
                    &r,
                    "--mode",
                    "plan"
                ]
            )
            .0
        );
        std::thread::sleep(std::time::Duration::from_millis(1300)); // the first occurrence falls due
        cron(&h, port, &["cron", "run", "--once"])
    })
    .await
    .unwrap();
    assert!(out.0, "{}", out.2);
    assert!(
        out.1.contains("rapida") && out.1.contains("1 tarea(s) ejecutada(s)."),
        "{}",
        out.1
    );

    // It ran as a normal run: it is in the history, with its own task as the objective.
    let runs: Value =
        serde_json::from_slice(&hivecode(home.path(), &["history", "--json"]).stdout).unwrap();
    assert_eq!(runs[0]["objective"], "hola desde cron");
    assert_eq!(runs[0]["status"], "completed");
    let (_, list, _) = cron(home.path(), port, &["cron", "list"]);
    assert!(list.contains("publicadas: 1"), "{list}");

    // Disabled, a due occurrence is not published.
    assert!(cron(home.path(), port, &["cron", "disable", "rapida"]).0);
    let (h,) = (home.path().to_owned(),);
    let again = tokio::task::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(1300));
        cron(&h, port, &["cron", "run", "--once"])
    })
    .await
    .unwrap();
    assert!(
        again.0 && again.1.contains("0 tarea(s) ejecutada(s)."),
        "{}",
        again.1
    );
    let runs: Value =
        serde_json::from_slice(&hivecode(home.path(), &["history", "--json"]).stdout).unwrap();
    assert_eq!(runs.as_array().unwrap().len(), 1, "no second run");
}
