//! One full turn against a local fake OpenAI-compatible server: the model asks for a file, the
//! host runs the sandboxed tool, the model answers with what it read. No real provider is used.
use hivecode_host::{Event, Host, HostConfig, Mode};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
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

async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let read = socket.read(&mut buffer).await.unwrap();
        data.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&data).into_owned();
        if let Some(split) = text.find("\r\n\r\n") {
            let length = text[..split]
                .to_ascii_lowercase()
                .lines()
                .find_map(|l| {
                    l.strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if data.len() >= split + 4 + length {
                return text[split + 4..].to_owned();
            }
        }
        if read == 0 {
            return String::new();
        }
    }
}

fn tool_call(name: &str, arguments: Value) -> String {
    sse(&[
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":name,"arguments":arguments.to_string()}}]},"finish_reason":null}]}),
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

/// Serves the scripted replies in order and records every request body.
async fn fake(script: Vec<String>) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let bodies: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = bodies.clone();
    tokio::spawn(async move {
        for reply in script {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            seen.lock().unwrap().push(request);
            socket.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    (port, bodies)
}

fn host(port: u16, project: &Path, state: &Path, mode: Mode) -> Host {
    Host::open(HostConfig {
        db: state.join("db"),
        root: project.to_owned(),
        provider: json!({"base_url": format!("http://127.0.0.1:{port}/v1"), "api_key": "fake"}),
        model: "fake-model".into(),
        system: Some("Eres un agente de código.".into()),
        agent: "bee".into(),
        session: "s1".into(),
        max_turns: 6,
        allowed_programs: vec![],
        mode,
    })
    .unwrap()
}

#[tokio::test]
async fn a_turn_reads_a_file_through_the_sdk_tools_and_answers() {
    let (port, bodies) = fake(vec![
        tool_call("fs_read", json!({"path":"hello.txt"})),
        answer("El archivo dice hola"),
    ])
    .await;
    let project = tempfile::tempdir().unwrap();
    std::fs::write(project.path().join("hello.txt"), "contenido-secreto-42").unwrap();
    let state = tempfile::tempdir().unwrap();
    let host = host(port, project.path(), state.path(), Mode::Plan);
    let mut events = vec![];
    let text = host
        .run(
            "Lee hello.txt",
            &mut |e| events.push(e),
            &mut |_, _| false,
            &Default::default(),
        )
        .await
        .unwrap();
    assert_eq!(text, "El archivo dice hola");
    assert!(events.contains(&Event::ToolDone {
        name: "fs_read".into(),
        ok: true
    }));
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    assert!(bodies[1].contains("contenido-secreto-42"));
}

#[tokio::test]
async fn plan_mode_blocks_writes_and_tells_the_model_why() {
    let (port, bodies) = fake(vec![
        tool_call("fs_write", json!({"path":"nuevo.txt","content":"x"})),
        answer("No pude escribir; dejo el plan"),
    ])
    .await;
    let project = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let host = host(port, project.path(), state.path(), Mode::Plan);
    let mut events = vec![];
    let mut asked = false;
    host.run(
        "Crea nuevo.txt",
        &mut |e| events.push(e),
        &mut |_, _| {
            asked = true;
            true
        },
        &Default::default(),
    )
    .await
    .unwrap();
    assert!(
        !project.path().join("nuevo.txt").exists(),
        "plan mode must not write"
    );
    assert!(!asked, "plan mode never asks: it refuses");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::ToolDenied { name, .. } if name == "fs_write"))
    );
    assert!(bodies.lock().unwrap()[1].contains("plan mode does not allow changes"));
}

#[tokio::test]
async fn approval_mode_asks_and_respects_the_answer() {
    for (accept, written) in [(true, true), (false, false)] {
        let (port, _) = fake(vec![
            tool_call("fs_write", json!({"path":"nuevo.txt","content":"hola"})),
            answer("listo"),
        ])
        .await;
        let project = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let host = host(port, project.path(), state.path(), Mode::Approval);
        let mut asked = vec![];
        host.run(
            "Crea nuevo.txt",
            &mut |_| {},
            &mut |name, _| {
                asked.push(name.to_owned());
                accept
            },
            &Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(asked, vec!["fs_write"]);
        assert_eq!(project.path().join("nuevo.txt").exists(), written);
    }
}

#[tokio::test]
async fn auto_mode_writes_without_asking_and_reads_never_ask() {
    let (port, _) = fake(vec![
        tool_call("fs_write", json!({"path":"a.txt","content":"hola"})),
        answer("hecho"),
    ])
    .await;
    let project = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let host = host(port, project.path(), state.path(), Mode::Auto);
    host.run(
        "Crea a.txt",
        &mut |_| {},
        &mut |_, _| panic!("auto never asks"),
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(project.path().join("a.txt")).unwrap(),
        "hola"
    );
}
