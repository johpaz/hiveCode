use color_eyre::eyre::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

// ── Priority envelope ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct IpcEnvelope {
    pub priority: String,
    #[allow(dead_code)]
    pub seq: u64,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload: serde_json::Value,
}

// ── Messages Bun → Rust ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BunMessage {
    Init {
        mode: String,
        provider: String,
        model: String,
        project_name: String,
        project_path: String,
        session_id: String,
        version: String,
        task_count: u32,
        token_count: u64,
        // Bug-F fix: was `agent_count: u32`, now a named list of worker ids
        workers: Vec<String>,
    },
    ConflictAlert {
        agent: String,
        file: String,
        reason: String,
        severity: String,
    },
    FileRiskUpdate {
        path: String,
        risk: String,
        operation: String,
        adr_ref: Option<String>,
        reason: String,
        agent: String,
    },
    CheckpointCreated {
        checkpoint_id: String,
        description: String,
        file_count: u32,
        agent: String,
    },
    CheckpointRollback {
        checkpoint_id: String,
        files_restored: u32,
    },
    ContextUpdate {
        agent: String,
        key: String,
        scope: String,
    },
    HistoryAppend {
        role: String,
        content: String,
        content_type: Option<String>,
    },
    Status {
        running: bool,
        msg: String,
    },
    StateUpdate {
        new_mode: Option<String>,
        new_provider: Option<String>,
        new_model: Option<String>,
    },
    Suggestions {
        items: Vec<String>,
    },
    QuickMenu {
        items: Vec<MenuItem>,
    },
    ShellOutput {
        stdout: String,
        stderr: String,
        exit_code: i32,
    },
    ActivityUpdate {
        coordinator: String,
        phase: String,
        status: String,
    },
    LogEntry {
        timestamp: String,
        level: String,
        source: String,
        message: String,
    },
    NarrativeChunk {
        coordinator: String,
        phase: String,
        content: String,
        // Kept for serde deserialization; not read by the handler
        #[allow(dead_code)]
        content_type: Option<String>,
        #[allow(dead_code)]
        stream_id: Option<String>,
    },
    ShowConfigModal {
        command: String,
        title: String,
        fields: Vec<ModalField>,
    },
    ShowInfoModal {
        title: String,
        content: String,
    },
    Suspend,
    Resume,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MenuItem {
    pub label: String,
    pub cmd: String,
    pub desc: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModalField {
    pub key: String,
    pub label: String,
    pub placeholder: String,
    pub required: bool,
    pub secret: bool,
    pub field_type: String, // "text" | "select"
    pub options: Option<Vec<String>>,
    pub default_value: Option<String>,
}

// ── Messages Rust → Bun ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TuiMessage {
    Ready,
    Submit { input: String },
    SuggestionsRequest { query: String },
    ModeChange { mode: String },
    ShellExecute { command: String },
    ModalSubmit { command: String, values: HashMap<String, String> },
    ModalCancel { command: String },
    InfoModalClose,
    Suspended,
    Exit,
}

// ── IPC channels (priority-separated) ────────────────────────────────────────

/// Three receivers, one per priority tier.
/// The event loop must use `biased select!` draining critical before normal before low.
pub struct IpcChannels {
    pub critical: mpsc::Receiver<BunMessage>,
    pub normal:   mpsc::Receiver<BunMessage>,
    pub low:      mpsc::Receiver<BunMessage>,
    pub sender:   mpsc::Sender<TuiMessage>,
}

// ── IPC connection ───────────────────────────────────────────────────────────

/// Connect to the Bun-side Unix socket and return priority-separated channels.
/// Silently no-ops (returns empty channels) if HIVECODE_IPC is not set (demo mode).
pub async fn connect() -> Result<IpcChannels> {
    let (critical_tx, critical_rx) = mpsc::channel::<BunMessage>(32);
    let (normal_tx,   normal_rx)   = mpsc::channel::<BunMessage>(128);
    let (low_tx,      low_rx)      = mpsc::channel::<BunMessage>(256);
    let (tui_tx, mut tui_rx)       = mpsc::channel::<TuiMessage>(64);

    let socket_path = std::env::var("HIVECODE_IPC").unwrap_or_default();

    eprintln!("[ipc] HIVECODE_IPC='{}' exists={}", socket_path, Path::new(&socket_path).exists());

    if !socket_path.is_empty() && Path::new(&socket_path).exists() {
        let stream = UnixStream::connect(&socket_path)
            .await
            .with_context(|| format!("connecting to IPC socket {socket_path}"))?;

        eprintln!("[ipc] Connected to Bun socket");

        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);

        // Bun → Rust reader task: parse envelope, reconstruct flat message, route by priority
        tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }

                        // Try envelope format first (new), then fall back to flat (legacy)
                        let (priority, msg_result) = if let Ok(env) = serde_json::from_str::<IpcEnvelope>(trimmed) {
                            let prio = env.priority.clone();
                            // Reconstruct flat message with "type" field injected
                            let flat = match env.payload {
                                serde_json::Value::Object(mut m) => {
                                    m.insert("type".to_string(), serde_json::Value::String(env.msg_type));
                                    serde_json::Value::Object(m)
                                }
                                other => {
                                    let mut m = serde_json::Map::new();
                                    m.insert("type".to_string(), serde_json::Value::String(env.msg_type));
                                    m.insert("_payload".to_string(), other);
                                    serde_json::Value::Object(m)
                                }
                            };
                            let msg = serde_json::from_value::<BunMessage>(flat);
                            (prio, msg)
                        } else {
                            // Legacy: flat JSON without envelope
                            ("normal".to_string(), serde_json::from_str::<BunMessage>(trimmed))
                        };

                        if let Ok(msg) = msg_result {
                            let tx = match priority.as_str() {
                                "critical" => &critical_tx,
                                "low"      => &low_tx,
                                _          => &normal_tx,
                            };
                            if tx.send(msg).await.is_err() { break; }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Rust → Bun writer task
        tokio::spawn(async move {
            while let Some(msg) = tui_rx.recv().await {
                if let Ok(mut json) = serde_json::to_string(&msg) {
                    json.push('\n');
                    if write_half.write_all(json.as_bytes()).await.is_err() {
                        break;
                    }
                }
            }
        });
    }

    Ok(IpcChannels { critical: critical_rx, normal: normal_rx, low: low_rx, sender: tui_tx })
}
