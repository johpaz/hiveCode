use std::env;

use color_eyre::eyre::Result;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::mpsc,
};

#[cfg(unix)]
use tokio::net::UnixStream;

// ── Wire format ───────────────────────────────────────────────────────────────

/// Envelope que el servidor Bun envuelve alrededor de cada BunMessage.
/// `{"protocol_version":1,"priority":"normal","seq":5,"session_id":"s1","type":"worker_update","payload":{...}}`
///
/// Por qué existe: permite que el lado Rust enrute al canal correcto usando
/// solo el campo `priority` sin deserializar el payload completo primero.
#[derive(Deserialize)]
struct IpcEnvelope {
    #[serde(default, rename = "protocol_version")]
    _protocol_version: Option<u16>,
    priority: String,
    #[serde(default, rename = "seq")]
    _seq: Option<u64>,
    #[serde(default, rename = "session_id")]
    session_id: Option<String>,
    #[serde(default, rename = "task_id")]
    task_id: Option<String>,
    #[serde(rename = "type")]
    msg_type: String,
    payload: sonic_rs::Value,
}

/// Aplana envelope → JSON plano listo para deserializar como BunMessage.
///
/// Entrada:  `{"protocol_version":1,"priority":"normal","seq":5,"task_id":"t1","type":"worker_update","payload":{"worker":"bee",...}}`
/// Salida:   `{"type":"worker_update","task_id":"t1","worker":"bee",...}`
///
/// Por qué string manipulation y no serde_json::merge: sonic_rs no expone
/// merge de Value; manipular el string es O(n) y evita una segunda alocación.
fn flatten_envelope(env: IpcEnvelope) -> Option<String> {
    let payload_str = sonic_rs::to_string(&env.payload).ok()?;
    let mut metadata = Vec::with_capacity(2);
    if let Some(session_id) = &env.session_id {
        if !payload_str.contains(r#""session_id""#) {
            metadata.push(format!(r#""session_id":{}"#, sonic_rs::to_string(session_id).ok()?));
        }
    }
    if let Some(task_id) = &env.task_id {
        if !payload_str.contains(r#""task_id""#) {
            metadata.push(format!(r#""task_id":{}"#, sonic_rs::to_string(task_id).ok()?));
        }
    }
    let metadata = if metadata.is_empty() {
        String::new()
    } else {
        format!(",{}", metadata.join(","))
    };
    let flat = if payload_str == "{}" {
        // AssistantDone y similares no tienen campos en payload
        format!(r#"{{"type":"{}"{}}}"#, env.msg_type, metadata)
    } else {
        // payload_str empieza con '{' → lo reemplazamos con '"type":"...",`
        format!(r#"{{"type":"{}"{},{}"#, env.msg_type, metadata, &payload_str[1..])
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
        agent: Option<String>,
        timestamp: Option<String>,
    },
    AssistantDone,
    /// Protocolo legado del tui-launcher: respuesta completa en un solo mensaje.
    HistoryAppend {
        role: String,
        content: String,
        content_type: Option<String>,
        agent: Option<String>,
        timestamp: Option<String>,
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
        new_token_count: Option<u64>,
    },

    // ── Workers y coordinador ──────────────────────────────────────────────────
    WorkerUpdate {
        task_id: Option<String>,
        worker: String,
        phase: String,
        status: String,
        display_name: Option<String>,
        activity: Option<String>,
    },
    /// Legado: mismos campos que WorkerUpdate pero nombre diferente.
    ActivityUpdate {
        task_id: Option<String>,
        coordinator: String,
        phase: String,
        status: String,
        display_name: Option<String>,
        activity: Option<String>,
    },

    // ── Checkpoints ────────────────────────────────────────────────────────────
    CheckpointCreated {
        /// El wire usa "checkpoint_id" pero el modelo usa "id".
        #[serde(rename = "checkpoint_id")]
        id: String,
        description: String,
        file_count: u32,
        agent: String,
        tests_passed: Option<u32>,
        tests_total: Option<u32>,
    },

    // ── Mapa de riesgo ─────────────────────────────────────────────────────────
    FileRiskUpdate {
        path: String,
        risk: String,
        operation: String,
        agent: String,
        adr_ref: Option<String>,
        reason: Option<String>,
        lines_added: Option<u32>,
        lines_removed: Option<u32>,
    },

    // ── Stream de pensamiento ──────────────────────────────────────────────────
    ThoughtChunk {
        task_id: Option<String>,
        coordinator: String,
        phase: String,
        content: String,
    },
    /// Legado del tui-launcher: narrative_chunk ≡ thought_chunk.
    NarrativeChunk {
        task_id: Option<String>,
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

    // ── Logs (low priority, forwarded by tui-launcher) ────────────────────────
    LogEntry {
        timestamp: String,
        level: String,
        source: String,
        message: String,
    },

    // ── Alertas ────────────────────────────────────────────────────────────────
    /// Wire: { agent, file, reason, severity } — matches protocol.ts
    ConflictAlert {
        agent_a: String,
        agent_b: String,
        file: String,
        reason: String,
        severity: String,
        detail: Option<String>,
    },
    Error {
        message: String,
    },

    // ── Rollback completado ────────────────────────────────────────────────────
    CheckpointRollback {
        checkpoint_id: String,
        files_restored: u32,
    },

    // ── ADRs (SQLite → Bun → TUI) ─────────────────────────────────────────────
    AdrUpdate {
        path:    String,
        title:   String,
        content: String,
        status:  String,
    },

    // ── Diff activo (git diff → Bun → TUI) ────────────────────────────────────
    FileDiff {
        path:   String,
        branch: Option<String>,
        stats_added: Option<u32>,
        stats_removed: Option<u32>,
        chunks: Vec<DiffLine>,
    },

    // ── Plan estructurado ─────────────────────────────────────────────────────
    PlanUpdate {
        task_id: String,
        adr_title: String,
        adr_content: String,
        status: String,
        phases: Vec<PlanPhaseIpc>,
        risks: Vec<PlanRiskIpc>,
    },
    PlanApprovalRequest,

    // ── Proyección de tareas concurrentes ─────────────────────────────────────
    TaskUpdate {
        task_id: String,
        title: Option<String>,
        status: String,
        mode: Option<String>,
        active_workers: Option<Vec<String>>,
        workspace_id: Option<String>,
        workspace_path: Option<String>,
        branch_name: Option<String>,
        isolated: Option<bool>,
        integration_status: Option<String>,
    },

    // ── Snapshots de inicio (dump de SQLite al conectar) ───────────────────────
    WorkersSnapshot { workers: Vec<WorkerSnapshotEntry> },
    FilesSnapshot   { files:   Vec<FileSnapshotEntry>   },

    // ── No-ops: Bun puede enviar estos; los ignoramos sin romper el parser ─────
    Suggestions { items: Vec<String> },
    QuickMenu { items: Vec<sonic_rs::Value> },
    ShellOutput { stdout: String, stderr: String, exit_code: i32 },
    Suspend,
    Resume,
    ContextUpdate { agent: String, key: String, scope: String },
    /// Datos del hub de settings (respuesta a RequestSettings).
    SettingsData {
        providers: Vec<IpcSettingsProvider>,
        mcp: Vec<IpcSettingsMcp>,
        skills: Vec<IpcSettingsSkill>,
        github_connected: bool,
        github_repo: Option<String>,
        telegram_active: bool,
    },
    /// Captura cualquier tipo de mensaje desconocido — evita que serde falle
    /// y corrompa el canal IPC cuando TypeScript agrega nuevos tipos.
    #[serde(other)]
    Unknown,
}

// ── Tipos de datos para nuevos mensajes ───────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct DiffLine {
    pub kind: String,
    pub text: String,
    pub old_line_no: Option<u32>,
    pub new_line_no: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct WorkerSnapshotEntry {
    pub name:   String,
    pub status: String,
    pub detail: Option<String>,
    pub display_name: Option<String>,
    pub activity: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FileSnapshotEntry {
    pub path:      String,
    pub risk:      String,
    pub operation: String,
    pub agent:     String,
}

#[derive(Debug, Deserialize)]
pub struct PlanPhaseIpc {
    pub name: String,
    pub coordinator: String,
    pub description: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub level: u32,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct PlanRiskIpc {
    pub severity: String,
    pub description: String,
}

// ── Tipos para el hub de settings ────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct IpcSettingsProvider {
    pub id: String,
    pub name: String,
    pub model: String,
    pub is_active: bool,
    pub has_key: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IpcSettingsMcp {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IpcSettingsSkill {
    pub name: String,
    pub description: String,
    pub category: String,
    pub active: bool,
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
    InfoModalClose,
    /// Solicita a Bun que envíe un SettingsData con el estado actual de la configuración.
    RequestSettings,
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

trait IpcStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> IpcStream for T {}

async fn connect_transport(endpoint: &str) -> std::io::Result<Box<dyn IpcStream>> {
    if let Some(address) = endpoint.strip_prefix("tcp://") {
        return TcpStream::connect(address)
            .await
            .map(|stream| Box::new(stream) as Box<dyn IpcStream>);
    }

    #[cfg(unix)]
    {
        return UnixStream::connect(endpoint)
            .await
            .map(|stream| Box::new(stream) as Box<dyn IpcStream>);
    }

    #[cfg(not(unix))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Windows requiere un endpoint IPC tcp://",
        ))
    }
}

/// Conecta al endpoint local de `HIVECODE_IPC`.
///
/// Demo mode si la variable no existe o el socket falla — la TUI
/// funciona independientemente del proceso Bun.
pub async fn connect() -> Result<IpcChannels> {
    let endpoint = match env::var("HIVECODE_IPC") {
        Ok(p) if !p.is_empty() => p,
        _ => return Ok(IpcChannels::demo()),
    };

    let stream = match connect_transport(&endpoint).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("hivetui: IPC {endpoint}: {e} — arrancando en demo mode");
            return Ok(IpcChannels::demo());
        }
    };

    let (critical_tx, critical_rx) = mpsc::channel::<BunMessage>(32);
    let (normal_tx, normal_rx) = mpsc::channel::<BunMessage>(128);
    let (low_tx, low_rx) = mpsc::channel::<BunMessage>(512);
    let (out_tx, mut out_rx) = mpsc::channel::<TuiMessage>(64);

    let (reader, mut writer) = tokio::io::split(stream);

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
            match priority.as_str() {
                "critical" => {
                    let _ = critical_tx.send(msg).await;
                }
                "low" => {
                    let _ = low_tx.try_send(msg);
                }
                _ => {
                    let _ = normal_tx.send(msg).await;
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flatten_envelope_preserves_routing_metadata() {
        let raw = r#"{"protocol_version":1,"priority":"normal","seq":7,"session_id":"s1","task_id":"task-1","type":"activity_update","payload":{"coordinator":"backend","phase":"editing","status":"running"}}"#;
        let env = sonic_rs::from_str::<IpcEnvelope>(raw).unwrap();
        let flat = flatten_envelope(env).unwrap();
        let msg = sonic_rs::from_str::<BunMessage>(&flat).unwrap();

        match msg {
            BunMessage::ActivityUpdate { task_id, coordinator, .. } => {
                assert_eq!(task_id.as_deref(), Some("task-1"));
                assert_eq!(coordinator, "backend");
            }
            _ => panic!("expected activity_update"),
        }
    }

    #[test]
    fn flatten_envelope_keeps_payload_task_id_when_present() {
        let raw = r#"{"protocol_version":1,"priority":"normal","seq":8,"task_id":"route-task","type":"task_update","payload":{"task_id":"payload-task","status":"running"}}"#;
        let env = sonic_rs::from_str::<IpcEnvelope>(raw).unwrap();
        let flat = flatten_envelope(env).unwrap();
        let msg = sonic_rs::from_str::<BunMessage>(&flat).unwrap();

        match msg {
            BunMessage::TaskUpdate { task_id, .. } => {
                assert_eq!(task_id, "payload-task");
            }
            _ => panic!("expected task_update"),
        }
    }
}
