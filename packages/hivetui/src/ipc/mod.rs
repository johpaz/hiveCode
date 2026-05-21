use std::env;

use color_eyre::eyre::Result;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    sync::mpsc,
};

// ── Wire format ───────────────────────────────────────────────────────────────

/// Envelope que el servidor Bun envuelve alrededor de cada BunMessage.
/// `{"priority":"normal","seq":5,"type":"worker_update","payload":{...}}`
///
/// Por qué existe: permite que el lado Rust enrute al canal correcto usando
/// solo el campo `priority` sin deserializar el payload completo primero.
#[derive(Deserialize)]
struct IpcEnvelope {
    priority: String,
    #[serde(rename = "type")]
    msg_type: String,
    payload: sonic_rs::Value,
}

/// Aplana envelope → JSON plano listo para deserializar como BunMessage.
///
/// Entrada:  `{"priority":"normal","seq":5,"type":"worker_update","payload":{"worker":"bee",...}}`
/// Salida:   `{"type":"worker_update","worker":"bee",...}`
///
/// Por qué string manipulation y no serde_json::merge: sonic_rs no expone
/// merge de Value; manipular el string es O(n) y evita una segunda alocación.
fn flatten_envelope(env: IpcEnvelope) -> Option<String> {
    let payload_str = sonic_rs::to_string(&env.payload).ok()?;
    let flat = if payload_str == "{}" {
        // AssistantDone y similares no tienen campos en payload
        format!(r#"{{"type":"{}"}}"#, env.msg_type)
    } else {
        // payload_str empieza con '{' → lo reemplazamos con '"type":"...",`
        format!(r#"{{"type":"{}",{}"#, env.msg_type, &payload_str[1..])
    };
    Some(flat)
}

// ── Mensajes Bun → TUI ────────────────────────────────────────────────────────

/// Variantes que la TUI entiende del servidor Bun.
/// `rename_all = "snake_case"` mapea "AssistantChunk" → "assistant_chunk" en wire.
/// Incluye las variantes del protocolo legado (tui-launcher.ts) para compatibilidad.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BunMessage {
    // ── Inicialización ─────────────────────────────────────────────────────────
    Init {
        session_id: String,
        workers: Vec<String>,
        // Campos del protocolo legado (tui-launcher.ts) — todos opcionales
        mode:         Option<String>,
        provider:     Option<String>,
        model:        Option<String>,
        project_name: Option<String>,
        project_path: Option<String>,
        version:      Option<String>,
        task_count:   Option<u32>,
        token_count:  Option<u64>,
    },

    // ── Respuesta del agente (streaming + batch) ───────────────────────────────
    /// Nuevo protocolo: streaming chunk a chunk.
    AssistantChunk {
        text: String,
    },
    AssistantDone,
    /// Protocolo legado del tui-launcher: respuesta completa en un solo mensaje.
    HistoryAppend {
        role: String,
        content: String,
        content_type: Option<String>,
    },

    // ── Estado de la sesión ────────────────────────────────────────────────────
    /// Barra de estado inferior: "Listo · [shift+tab]…" o "Pensando…"
    Status {
        running: bool,
        msg: String,
    },
    /// Cambio de modo/provider/modelo en caliente.
    StateUpdate {
        new_mode: Option<String>,
        new_provider: Option<String>,
        new_model: Option<String>,
    },

    // ── Workers y coordinador ──────────────────────────────────────────────────
    WorkerUpdate {
        worker: String,
        phase: String,
        status: String,
    },
    /// Legado: mismos campos que WorkerUpdate pero nombre diferente.
    ActivityUpdate {
        coordinator: String,
        phase: String,
        status: String,
    },

    // ── Checkpoints ────────────────────────────────────────────────────────────
    CheckpointCreated {
        /// El wire usa "checkpoint_id" pero el modelo usa "id".
        #[serde(rename = "checkpoint_id")]
        id: String,
        description: String,
        file_count: u32,
        agent: String,
    },

    // ── Mapa de riesgo ─────────────────────────────────────────────────────────
    FileRiskUpdate {
        path: String,
        risk: String,
        operation: String,
        agent: String,
    },

    // ── Stream de pensamiento ──────────────────────────────────────────────────
    ThoughtChunk {
        coordinator: String,
        phase: String,
        content: String,
    },
    /// Legado del tui-launcher: narrative_chunk ≡ thought_chunk.
    NarrativeChunk {
        coordinator: String,
        phase: String,
        content: String,
        content_type: Option<String>,
        stream_id: Option<String>,
    },

    // ── Modales (enviados por Bun cuando un comando los requiere) ─────────────
    ShowConfigModal {
        command: String,
        title: String,
        fields: Vec<IpcModalField>,
    },
    ShowInfoModal {
        title: String,
        content: String,
    },

    // ── Alertas ────────────────────────────────────────────────────────────────
    ConflictAlert {
        worker_a: String,
        worker_b: String,
        file: String,
    },
    Error {
        message: String,
    },
}

/// Definición de campo de modal que llega del servidor Bun.
#[derive(Debug, Deserialize)]
pub struct IpcModalField {
    pub key: String,
    pub label: String,
    pub placeholder: Option<String>,
    pub required: Option<bool>,
    pub secret: Option<bool>,
    pub field_type: Option<String>,
    pub options: Option<Vec<String>>,
    pub default_value: Option<String>,
}

// ── Mensajes TUI → Bun ────────────────────────────────────────────────────────

/// `input` (no `text`) para coincidir con el tipo TuiMessage del core TS.
/// `exit` (no `quit`) ídem.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TuiMessage {
    Ready,
    Submit { input: String },
    Rollback { checkpoint_id: String },
    ModeChange { mode: String },
    ModalSubmit { command: String, values: std::collections::HashMap<String, String> },
    ModalCancel { command: String },
    Exit,
}

// ── Canales IPC ───────────────────────────────────────────────────────────────

/// Tres canales por prioridad para `tokio::select! biased`.
///
/// biased procesa ramas en orden → critical se drena antes que normal,
/// normal antes que low. Sin esto un flood de AssistantChunk puede
/// retrasar alertas de conflicto.
pub struct IpcChannels {
    pub critical: mpsc::Receiver<BunMessage>,
    pub normal: mpsc::Receiver<BunMessage>,
    pub low: mpsc::Receiver<BunMessage>,
    pub tx: mpsc::Sender<TuiMessage>,
}

impl IpcChannels {
    /// Canales vacíos → demo mode sin proceso Bun.
    pub fn demo() -> Self {
        let (_, critical) = mpsc::channel(1);
        let (_, normal) = mpsc::channel(1);
        let (_, low) = mpsc::channel(1);
        let (tx, _) = mpsc::channel(1);
        Self { critical, normal, low, tx }
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Conecta al Unix socket de `HIVECODE_IPC`.
///
/// Demo mode si la variable no existe o el socket falla — la TUI
/// funciona independientemente del proceso Bun.
pub async fn connect() -> Result<IpcChannels> {
    let socket_path = match env::var("HIVECODE_IPC") {
        Ok(p) if !p.is_empty() => p,
        _ => return Ok(IpcChannels::demo()),
    };

    let stream = match UnixStream::connect(&socket_path).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("hivetui: socket {socket_path}: {e} — arrancando en demo mode");
            return Ok(IpcChannels::demo());
        }
    };

    let (critical_tx, critical_rx) = mpsc::channel::<BunMessage>(32);
    let (normal_tx, normal_rx) = mpsc::channel::<BunMessage>(128);
    let (low_tx, low_rx) = mpsc::channel::<BunMessage>(512);
    let (out_tx, mut out_rx) = mpsc::channel::<TuiMessage>(64);

    let (reader, mut writer) = stream.into_split();

    // Tarea lectora: NDJSON envelope → canal por prioridad
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.is_empty() {
                continue;
            }
            let Ok(env) = sonic_rs::from_str::<IpcEnvelope>(&line) else {
                continue;
            };
            let priority = env.priority.clone();
            let Some(flat) = flatten_envelope(env) else {
                continue;
            };
            let Ok(msg) = sonic_rs::from_str::<BunMessage>(&flat) else {
                continue;
            };
            let _ = match priority.as_str() {
                "critical" => critical_tx.send(msg).await,
                "low" => low_tx.send(msg).await,
                _ => normal_tx.send(msg).await,
            };
        }
    });

    // Tarea escritora: TuiMessage → NDJSON plano → socket
    tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if let Ok(mut json) = sonic_rs::to_string(&msg) {
                json.push('\n');
                if writer.write_all(json.as_bytes()).await.is_err() {
                    break;
                }
            }
        }
    });

    Ok(IpcChannels {
        critical: critical_rx,
        normal: normal_rx,
        low: low_rx,
        tx: out_tx,
    })
}
