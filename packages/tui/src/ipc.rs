use color_eyre::eyre::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

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
        version: String,
        task_count: u32,
        token_count: u64,
        agent_count: u32,
    },
    HistoryAppend {
        role: String,
        content: String,
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
    Suspend,
    Resume,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MenuItem {
    pub label: String,
    pub cmd: String,
    pub desc: String,
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
    Suspended,
    Exit,
}

// ── IPC connection ───────────────────────────────────────────────────────────

/// Connect to the Bun-side Unix socket and return async channels.
/// Returns (receiver of Bun messages, sender of Tui messages).
/// Silently no-ops if HIVECODE_IPC is not set (demo mode).
pub async fn connect() -> Result<(
    mpsc::Receiver<BunMessage>,
    mpsc::Sender<TuiMessage>,
)> {
    let (bun_tx, bun_rx) = mpsc::channel::<BunMessage>(64);
    let (tui_tx, mut tui_rx) = mpsc::channel::<TuiMessage>(64);

    let socket_path = std::env::var("HIVECODE_IPC").unwrap_or_default();

    if !socket_path.is_empty() && Path::new(&socket_path).exists() {
        let stream = UnixStream::connect(&socket_path)
            .await
            .with_context(|| format!("connecting to IPC socket {socket_path}"))?;

        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);

        // Bun → Rust reader task
        tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            if let Ok(msg) = serde_json::from_str::<BunMessage>(trimmed) {
                                if bun_tx.send(msg).await.is_err() {
                                    break;
                                }
                            }
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

    Ok((bun_rx, tui_tx))
}
