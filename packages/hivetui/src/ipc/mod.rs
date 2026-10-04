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
        #[serde(default)]
        token_count: Option<u64>,
        #[serde(default)]
        level: Option<u32>,
        #[serde(default)]
        current_action: Option<String>,
        #[serde(default)]
        current_file: Option<String>,
        #[serde(default)]
        iteration_current: Option<u32>,
        #[serde(default)]
        iteration_total: Option<u32>,
        #[serde(default)]
        transversal: Option<bool>,
    },
    /// Legado: mismos campos que WorkerUpdate pero nombre diferente.
    ActivityUpdate {
        task_id: Option<String>,
        coordinator: String,
        phase: String,
        status: String,
        display_name: Option<String>,
        activity: Option<String>,
        #[serde(default)]
        token_count: Option<u64>,
        #[serde(default)]
        level: Option<u32>,
        #[serde(default)]
        current_action: Option<String>,
        #[serde(default)]
        current_file: Option<String>,
        #[serde(default)]
        iteration_current: Option<u32>,
        #[serde(default)]
        iteration_total: Option<u32>,
        #[serde(default)]
        transversal: Option<bool>,
    },

    DashboardSnapshot {
        #[serde(default)]
        workers: Vec<WorkerSnapshotEntry>,
        #[serde(default)]
        blackboard_events: Vec<BlackboardEventIpc>,
        #[serde(default)]
        conflicts: Vec<AgentConflictIpc>,
        #[serde(default)]
        levels: Vec<DashboardLevelIpc>,
        #[serde(default)]
        checkpoints: Vec<CheckpointIpc>,
        #[serde(default)]
        metrics: Option<DashboardMetricsIpc>,
        #[serde(default)]
        security: Option<SecurityStatusIpc>,
        #[serde(default)]
        halt: Option<HaltStateIpc>,
    },
    BlackboardEvent {
        timestamp: String,
        agent: String,
        #[serde(rename = "event_type")]
        event_type: String,
        content: String,
    },
    ConflictResolved {
        agent_a: Option<String>,
        agent_b: Option<String>,
        file: Option<String>,
    },
    ForensicAlert {
        worker: String,
        analysis: String,
        recommendation: String,
    },
    SecurityStatusUpdate {
        status: String,
        #[serde(default)]
        findings: Option<u32>,
    },
    HaltState {
        active: bool,
        reason: Option<String>,
        checkpoint_id: Option<String>,
    },
    MetricsUpdate {
        #[serde(default)]
        token_count: Option<u64>,
        #[serde(default)]
        cost: Option<String>,
        #[serde(default)]
        elapsed_secs: Option<u64>,
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

    // ── ADRs (storage → Bun → TUI) ────────────────────────────────────────────
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
        #[serde(default)]
        api_contracts: Vec<ApiContractIpc>,
    },
    PlanDraftUpdate {
        task_id: Option<String>,
        adr_title: Option<String>,
        adr_content: Option<String>,
        #[serde(default)]
        phases: Vec<PlanPhaseIpc>,
        #[serde(default)]
        risks: Vec<PlanRiskIpc>,
        #[serde(default)]
        api_contracts: Vec<ApiContractIpc>,
    },
    PlanApprovalRequest,

    ReviewVerdictUpdate {
        reviewer: Option<String>,
        status: String,
        summary: String,
        #[serde(default)]
        observations: Vec<String>,
        #[serde(default)]
        requested_changes: Vec<String>,
        #[serde(default)]
        affected_files: Vec<String>,
        /// Structured acceptance-criteria checklist (Fase 4: submit_review_verdict).
        /// Additive — absent when the reviewer model didn't call the structured
        /// tool, in which case the view falls back to the observation heuristic.
        #[serde(default)]
        criteria: Vec<ReviewCriterionIpc>,
        #[serde(default)]
        categories: Vec<ReviewCategoryIpc>,
    },

    /// Un checkpoint quedó disponible para reanudar tras la reconciliación de
    /// boot (una tarea `running` sin lease vigente, dejada por un proceso previo).
    ResumeAvailable {
        task_id: String,
        checkpoint_id: String,
        reason: String,
    },

    /// Una fase/worker está reintentando con backoff exponencial tras un crash
    /// o fallo transitorio — informativo, no bloqueante.
    PhaseRetry {
        worker: String,
        attempt: u32,
        max_attempts: u32,
        reason: String,
    },

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

    // ── Snapshots de inicio (dump de estado al conectar) ───────────────────────
    WorkersSnapshot { workers: Vec<WorkerSnapshotEntry> },
    FilesSnapshot   { files:   Vec<FileSnapshotEntry>   },

    // ── No-ops: Bun puede enviar estos; los ignoramos sin romper el parser ─────
    QuickMenu { items: Vec<sonic_rs::Value> },
    Suspend,
    Resume,
    ContextUpdate { agent: String, key: String, scope: String },
    /// Progreso del Librarian mientras destila memoria de proyecto.
    LibrarianProgress {
        status: String,
        #[serde(default)]
        records_written: u64,
    },
    /// Resumen de lo que el Librarian escribió en memoria.
    MemoryUpdate {
        #[serde(default)]
        records_added: u64,
        #[serde(default)]
        records_updated: u64,
        #[serde(default)]
        records_deprecated: u64,
    },
    /// Datos del hub de settings (respuesta a RequestSettings).
    SettingsData {
        providers: Vec<IpcSettingsProvider>,
        agents: Vec<IpcSettingsAgent>,
        mcp: Vec<IpcSettingsMcp>,
        skills: Vec<IpcSettingsSkill>,
        github_connected: bool,
        github_repo: Option<String>,
        telegram_active: bool,
    },

    // ── Jev: el plano de decisión ───────────────────────────────────────────
    // Jev ya emitía estos eventos en el event bus del backend y nadie estaba
    // suscrito: se calculaba el "por qué" de cada decisión y se tiraba. Esta es
    // la primeraconsumer.
    /// Una decisión servida y aplicada: qué podó, si puede paralelizar, a qué
    /// especialista delegó.
    JevDecision {
        agent_id: String,
        /// "context" (podar + delegar), "parallel", "iteration".
        kind: String,
        summary: String,
        saved_tokens: u64,
        cost_usd: f64,
        latency_ms: u64,
        /// Id estable, para deduplicar tras una reconexión.
        event_id: String,
        totals: IpcJevTotals,
    },
    /// Disponibilidad del oráculo. `off` = no configurado; `fallback` = enfriándose
    /// tras fallos. La UI no debe pintar `off` como error.
    JevStatus {
        state: String,
        last_error: Option<String>,
        last_success_at: Option<u64>,
        totals: IpcJevTotals,
    },

    // ── Telemetría del enjambre ───────────────────────────────────────────
    // Antes de esto la TUI solo recibía `current_action`, un texto libre que el
    // backend llenaba con "ejecutando <phase>": no decía qué herramienta corría
    // ni cuánto tardaba. Estos tres eventos son el pulso real.
    /// Un agente empezó una llamada. Siempre emparejado con un `ToolDone` del
    /// mismo `call_id`.
    ToolCall {
        agent: String,
        tool: String,
        call_id: String,
        /// Recortado a 120 chars en el emisor: un payload de 400 KB no se
        /// renderiza en una columna de 30 celdas.
        args_summary: String,
        #[serde(default)]
        bee_state: String,
        #[serde(default)]
        task_id: Option<String>,
        #[serde(default)]
        at: u64,
    },
    /// Una llamada terminó, bien o mal.
    ToolDone {
        agent: String,
        tool: String,
        call_id: String,
        ok: bool,
        duration_ms: u64,
        #[serde(default)]
        result_summary: String,
        #[serde(default)]
        task_id: Option<String>,
        #[serde(default)]
        at: u64,
    },
    /// Un agente no puede avanzar hasta que pase algo. `razon` nombra la causa
    /// (`"jev_secuencial"`, `"subagente"`, `"dependencia"`), no una frase, para
    /// que la UI pueda agrupar por motivo.
    Esperando {
        agent: String,
        #[serde(default)]
        esperando_a: Vec<String>,
        razon: String,
        #[serde(default)]
        task_id: Option<String>,
        #[serde(default)]
        at: u64,
    },

    /// El enjambre entero, una vez. Llega en `init` y en cada alta/baja de
    /// agente; nunca en el camino caliente.
    ///
    /// Es `describeSwarmCapabilities()` serializado: un solo roster, una sola
    /// lectura de los campos de capacidad. `mcp[].state` viaja con él para que
    /// la UI pueda marcar especialistas bloqueados antes de la primera decisión,
    /// sin esperar a `agentMcpOff`.
    RosterSnapshot {
        agentes: Vec<IpcRosterAgent>,
        #[serde(default)]
        mcp_servers: Vec<IpcRosterMcp>,
    },

    /// Captura cualquier tipo de mensaje desconocido — evita que serde falle
    /// y corrompa el canal IPC cuando TypeScript agrega nuevos tipos.
    #[serde(other)]
    Unknown,
}

/// Acumulado del oráculo. Viaja con cada decisión para que el statusbar pueda
/// mostrar "ahorró N tokens / $X" sin pedir nada.
#[derive(Debug, Clone, Deserialize)]
pub struct IpcJevTotals {
    pub decisions: u64,
    pub saved_tokens: u64,
    pub cost_usd: f64,
}

/// Un especialista del roster.
#[derive(Debug, Clone, Deserialize)]
pub struct IpcRosterAgent {
    pub id: String,
    /// Rol interno: `backend`, `frontend`… lo que viaja por el bus.
    pub rol: String,
    /// Alias visible: `Topo`, `Quetzal`… lo que el usuario lee.
    pub alias: String,
    #[serde(default)]
    pub funcion: String,
    /// 0 = comandante … 5 = on-demand. Misma escala que `AgentTier`.
    #[serde(default)]
    pub nivel: u8,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub mcp: Vec<IpcRosterMcpRef>,
}

/// Un servidor MCP y su estado. `apagado` bloquea a quien dependa de él.
#[derive(Debug, Clone, Deserialize)]
pub struct IpcRosterMcpRef {
    pub name: String,
    /// "activo" | "disponible" | "apagado"
    pub state: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IpcRosterMcp {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tools: u64,
    pub state: String,
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
    #[serde(default)]
    pub token_count: Option<u64>,
    #[serde(default)]
    pub level: Option<u32>,
    #[serde(default)]
    pub current_action: Option<String>,
    #[serde(default)]
    pub current_file: Option<String>,
    #[serde(default)]
    pub iteration_current: Option<u32>,
    #[serde(default)]
    pub iteration_total: Option<u32>,
    #[serde(default)]
    pub transversal: Option<bool>,
    #[serde(default)]
    pub replaces_worker: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlackboardEventIpc {
    pub timestamp: String,
    pub agent: String,
    #[serde(rename = "event_type")]
    pub event_type: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentConflictIpc {
    pub agent_a: String,
    pub agent_b: String,
    pub file: Option<String>,
    pub reason: String,
    pub severity: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DashboardLevelIpc {
    pub level: u32,
    pub label: String,
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CheckpointIpc {
    #[serde(rename = "checkpoint_id")]
    pub id: String,
    pub description: String,
    #[serde(default)]
    pub file_count: u32,
    pub agent: String,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(default)]
    pub tests_passed: Option<u32>,
    #[serde(default)]
    pub tests_total: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DashboardMetricsIpc {
    #[serde(default)]
    pub token_count: Option<u64>,
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(default)]
    pub elapsed_secs: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SecurityStatusIpc {
    pub status: String,
    #[serde(default)]
    pub findings: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HaltStateIpc {
    pub active: bool,
    pub reason: Option<String>,
    pub checkpoint_id: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewCriterionIpc {
    pub description: String,
    pub met: bool,
    #[serde(default)]
    pub evidence: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewCategoryIpc {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ApiContractIpc {
    pub name: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub request: String,
    #[serde(default)]
    pub response: String,
    #[serde(default)]
    pub status: String,
}

// ── Tipos para el hub de settings ────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct IpcSettingsProvider {
    pub id: String,
    pub name: String,
    pub model: String,
    pub is_active: bool,
    /// Lo responde Bun consultando el keystore (`hasProviderApiKey`). Antes
    /// venía hardcodeado a `true`, así que la columna `Key` de la TUI marcaba
    /// `✓` para todo provider y no señalaba cuáles necesitaban clave.
    pub has_key: bool,
    /// El provider se autentica con login de navegador (PKCE) en vez de API key.
    #[serde(default)]
    pub browser_login: bool,
    /// Modelos llm habilitados de este provider. El tab Modelos lista solo los del
    /// provider activo; sin provider activo la lista queda vacía y hay que elegir
    /// uno primero.
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IpcSettingsAgent {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub max_turns: u32,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
    pub max_cost_usd: f64,
    pub permission_profile: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IpcSettingsMcp {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    pub has_headers: bool,
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
    /// Activar un provider ya elegido en la TUI, opcionalmente Guardando su API
    /// key en el keystore. Sustituye a mandar `/provider set <id>` como `Submit`:
    /// ese camino ignoraba el id y Bun volvía a abrir la lista completa de
    /// providers para que el usuario volviera a elegir el mismo.
    ///
    /// `api_key` llega en `None` cuando el provider ya tenía clave o usa login
    /// de navegador; Bun no vuelve a preguntar.
    ProviderActivate { provider_id: String, api_key: Option<String> },
    InfoModalClose,
    /// Confirma a Bun que la TUI soltó el terminal y ya puede usarlo.
    /// Sin esto `suspendTui()` en tui-launcher.ts nunca resuelve.
    Suspended,
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

    /// Deserializa un NDJSON tal como lo emite Bun y devuelve el mensaje plano.
    fn parse(line: &str) -> BunMessage {
        let env = sonic_rs::from_str::<IpcEnvelope>(line)
            .unwrap_or_else(|e| panic!("envelope inválido: {e}\n{line}"));
        let flat = flatten_envelope(env).unwrap_or_else(|| panic!("envelope aplanable: {line}"));
        sonic_rs::from_str::<BunMessage>(&flat)
            .unwrap_or_else(|e| panic!("payload inválido: {e}\n{flat}"))
    }

    // ── Telemetría del enjambre ────────────────────────────────────────────
    //
    // Estos JSON son copia literal de lo que emite `repl.ts` al reenviar los
    // eventos del event bus. Los tests de TS (`tests/ipc/swarm-telemetry.test.ts`)
    // fijan los nombres del lado TypeScript, pero no pueden comprobar que serde
    // los reconozca: si un campo se renombra en un lado, serde lo **ignora en
    // silencio** y el valor queda en su default. Estos tests son los que
    // detectan esa divergencia.

    #[test]
    fn tool_call_deserializes_every_field_the_backend_sends() {
        let msg = parse(
            r#"{"protocol_version":1,"priority":"normal","seq":1,"type":"tool_call","payload":{"agent":"a1","tool":"fs_write","call_id":"c1","args_summary":"{ \"path\": \"src/auth/token.ts\" }","bee_state":"writing","task_id":"task-9","at":1700000000000}}"#,
        );
        match msg {
            BunMessage::ToolCall { agent, tool, call_id, args_summary, bee_state, task_id, at } => {
                assert_eq!(agent, "a1");
                assert_eq!(tool, "fs_write");
                assert_eq!(call_id, "c1");
                assert!(args_summary.contains("token.ts"));
                assert_eq!(bee_state, "writing");
                assert_eq!(task_id.as_deref(), Some("task-9"));
                assert_eq!(at, 1_700_000_000_000);
            }
            other => panic!("esperaba tool_call, llegó {other:?}"),
        }
    }

    #[test]
    fn tool_done_keeps_its_duration_and_outcome() {
        let msg = parse(
            r#"{"protocol_version":1,"priority":"normal","seq":2,"type":"tool_done","payload":{"agent":"a1","tool":"fs_write","call_id":"c1","ok":true,"duration_ms":412,"result_summary":"+14 -3","at":1700000000412}}"#,
        );
        match msg {
            BunMessage::ToolDone { ok, duration_ms, call_id, result_summary, .. } => {
                assert!(ok);
                assert_eq!(duration_ms, 412, "una duración perdida se ve como 0 ms");
                assert_eq!(call_id, "c1");
                assert_eq!(result_summary, "+14 -3");
            }
            other => panic!("esperaba tool_done, llegó {other:?}"),
        }
    }

    #[test]
    fn a_failed_tool_call_is_not_mistaken_for_a_successful_one() {
        let msg = parse(
            r#"{"protocol_version":1,"priority":"normal","seq":3,"type":"tool_done","payload":{"agent":"a1","tool":"shell_executor","call_id":"c2","ok":false,"duration_ms":90,"result_summary":"boom","at":1}}"#,
        );
        match msg {
            BunMessage::ToolDone { ok, tool, .. } => {
                assert!(!ok, "un fallo silenciado mostraría una tool verde");
                assert_eq!(tool, "shell_executor");
            }
            other => panic!("esperaba tool_done, llegó {other:?}"),
        }
    }

    #[test]
    fn esperando_arrives_with_its_cause_and_targets() {
        let msg = parse(
            r#"{"protocol_version":1,"priority":"normal","seq":4,"type":"esperando","payload":{"agent":"topo","esperando_a":["condor"],"razon":"dependencia","at":1700000000000}}"#,
        );
        match msg {
            BunMessage::Esperando { agent, esperando_a, razon, .. } => {
                assert_eq!(agent, "topo");
                assert_eq!(razon, "dependencia");
                assert_eq!(esperando_a, vec!["condor".to_string()]);
            }
            other => panic!("esperaba esperando, llegó {other:?}"),
        }
    }

    #[test]
    fn a_sequential_wait_with_no_targets_still_parses() {
        // "en secuencia" no depende de nadie: la lista vacía es legítima.
        let msg = parse(
            r#"{"protocol_version":1,"priority":"normal","seq":5,"type":"esperando","payload":{"agent":"topo","esperando_a":[],"razon":"jev_secuencial","at":1}}"#,
        );
        match msg {
            BunMessage::Esperando { esperando_a, razon, .. } => {
                assert!(esperando_a.is_empty());
                assert_eq!(razon, "jev_secuencial");
            }
            other => panic!("esperaba esperando, llegó {other:?}"),
        }
    }

    /// Lo que el espejo de TypeScript NO puede detectar.
    ///
    /// Si alguien renombra `duration_ms` en un lado, serde **no** degrada a 0:
    /// rechaza el mensaje entero y la TUI se queda sin el `tool_done` — el
    /// spinner de esa tool gira para siempre sin explicación. Por eso los
    /// campos esenciales llevan `#[serde(default)]`: el mensaje llega, se ve la
    /// tool cerrada, y solo el dato ausente queda en su default.
    ///
    /// Este test fija esa diferencia entre "el mensaje se pierde" y "el dato se
    /// pierde", que es la razón de ser de los defaults.
    #[test]
    fn a_missing_essential_field_drops_the_message_entirely() {
        // `durationMs` en vez de `duration_ms`: exactamente lo que se vería si
        // el backend empezara a mandar camelCase por accidente.
        let raw = r#"{"protocol_version":1,"priority":"normal","seq":6,"type":"tool_done","payload":{"agent":"a1","tool":"fs_read","call_id":"c9","ok":true,"durationMs":777,"result_summary":"ok","at":1}}"#;
        let env = sonic_rs::from_str::<IpcEnvelope>(raw).unwrap();
        let flat = flatten_envelope(env).unwrap();
        assert!(
            sonic_rs::from_str::<BunMessage>(&flat).is_err(),
            "si esto pasa a parsear, `duration_ms` ganó un default y el mensaje \
             ya no se pierde — actualiza este test y la nota del enum."
        );
    }

    #[test]
    fn a_non_essential_field_may_be_omitted_without_losing_the_event() {
        // El caso contrario: `bee_state` y `task_id` sí tienen default, así que
        // un backend que no los mande no rompe nada.
        let raw = r#"{"protocol_version":1,"priority":"normal","seq":7,"type":"tool_call","payload":{"agent":"a1","tool":"fs_read","call_id":"c9","args_summary":"","at":1}}"#;
        let env = sonic_rs::from_str::<IpcEnvelope>(raw).unwrap();
        let flat = flatten_envelope(env).unwrap();
        let msg = sonic_rs::from_str::<BunMessage>(&flat).expect("debe parsear");
        match msg {
            BunMessage::ToolCall { call_id, bee_state, task_id, .. } => {
                assert_eq!(call_id, "c9");
                assert_eq!(bee_state, "");
                assert!(task_id.is_none());
            }
            other => panic!("esperaba tool_call, llegó {other:?}"),
        }
    }

    // ── Jev ────────────────────────────────────────────────────────────────

    #[test]
    fn jev_decision_deserializes_its_savings() {
        let msg = parse(
            r#"{"protocol_version":1,"priority":"normal","seq":7,"type":"jev_decision","payload":{"agent_id":"a1","kind":"context","summary":"18 → 6 mensajes · 3 tools","saved_tokens":8200,"cost_usd":0.0003,"latency_ms":61,"event_id":"jev:m2k9:3","totals":{"decisions":12,"saved_tokens":48200,"cost_usd":0.021}}}"#,
        );
        match msg {
            BunMessage::JevDecision { agent_id, kind, summary, saved_tokens, cost_usd, latency_ms, event_id, totals } => {
                assert_eq!(agent_id, "a1");
                assert_eq!(kind, "context");
                assert!(summary.contains("18"));
                assert_eq!(saved_tokens, 8_200);
                assert!((cost_usd - 0.0003).abs() < 1e-9, "el costo llega como f64 exacto");
                assert_eq!(latency_ms, 61);
                assert_eq!(event_id, "jev:m2k9:3");
                assert_eq!(totals.decisions, 12);
                assert_eq!(totals.saved_tokens, 48_200);
                assert!((totals.cost_usd - 0.021).abs() < 1e-9);
            }
            other => panic!("esperaba jev_decision, llegó {other:?}"),
        }
    }

    #[test]
    fn an_unavailable_oracle_reports_off_and_keeps_its_null_error() {
        // `off` = no configurado. Si `state` se perdiera, quedaría como string
        // vacío y la TUI asumiría "listo".
        let msg = parse(
            r#"{"protocol_version":1,"priority":"low","seq":8,"type":"jev_status","payload":{"state":"off","last_error":null,"last_success_at":null,"totals":{"decisions":0,"saved_tokens":0,"cost_usd":0}}}"#,
        );
        match msg {
            BunMessage::JevStatus { state, last_error, last_success_at, .. } => {
                assert_eq!(state, "off");
                assert!(last_error.is_none());
                assert!(last_success_at.is_none());
            }
            other => panic!("esperaba jev_status, llegó {other:?}"),
        }
    }

    #[test]
    fn a_cooling_oracle_keeps_its_error_text() {
        let msg = parse(
            r#"{"protocol_version":1,"priority":"low","seq":9,"type":"jev_status","payload":{"state":"fallback","last_error":"OpenRouter HTTP 429","last_success_at":1700000000,"totals":{"decisions":3,"saved_tokens":900,"cost_usd":0.001}}}"#,
        );
        match msg {
            BunMessage::JevStatus { state, last_error, .. } => {
                assert_eq!(state, "fallback");
                assert_eq!(last_error.as_deref(), Some("OpenRouter HTTP 429"));
            }
            other => panic!("esperaba jev_status, llegó {other:?}"),
        }
    }

    #[test]
    fn optional_swarm_fields_missing_from_the_wire_do_not_break_the_parse() {
        // El backend puede omitir `task_id` y `bee_state`. Con `#[serde(default)]`
        // debe parsear igual; sin él, el mensaje entero se descarta.
        let msg = parse(
            r#"{"protocol_version":1,"priority":"normal","seq":10,"type":"tool_call","payload":{"agent":"a1","tool":"fs_read","call_id":"c1","args_summary":"","at":1}}"#,
        );
        match msg {
            BunMessage::ToolCall { bee_state, task_id, .. } => {
                assert_eq!(bee_state, "");
                assert!(task_id.is_none());
            }
            other => panic!("esperaba tool_call, llegó {other:?}"),
        }
    }

    // ── Roster ─────────────────────────────────────────────────────────────

    #[test]
    fn roster_snapshot_deserializes_identity_and_capabilities() {
        let msg = parse(
            r#"{"protocol_version":1,"priority":"low","seq":11,"type":"roster_snapshot","payload":{"agentes":[{"id":"agent-1","rol":"backend","alias":"Topo","funcion":"Excava la infraestructura.","nivel":2,"tools":["fs_read","fs_write"],"mcp":[{"name":"obscura","state":"apagado"}]}],"mcp_servers":[{"id":"s1","name":"obscura","tools":37,"state":"apagado"}]}}"#,
        );
        match msg {
            BunMessage::RosterSnapshot { agentes, mcp_servers } => {
                assert_eq!(agentes.len(), 1);
                let a = &agentes[0];
                assert_eq!(a.id, "agent-1");
                assert_eq!(a.rol, "backend");
                assert_eq!(a.alias, "Topo");
                assert!(a.funcion.contains("infraestructura"));
                assert_eq!(a.nivel, 2);
                assert_eq!(a.tools, vec!["fs_read".to_string(), "fs_write".to_string()]);
                assert_eq!(a.mcp.len(), 1);
                assert_eq!(a.mcp[0].name, "obscura");
                assert_eq!(a.mcp[0].state, "apagado");
                assert_eq!(mcp_servers.len(), 1);
                assert_eq!(mcp_servers[0].tools, 37);
            }
            other => panic!("esperaba roster_snapshot, llegó {other:?}"),
        }
    }

    #[test]
    fn a_roster_agent_without_mcp_or_function_still_parses() {
        // Un subagente efímero no tiene MCP ni descripción larga. La ausencia no
        // puede costar el snapshot entero.
        let msg = parse(
            r#"{"protocol_version":1,"priority":"low","seq":12,"type":"roster_snapshot","payload":{"agentes":[{"id":"h1","rol":"scout","alias":"Hormiga-01","nivel":5,"tools":[]}]}}"#,
        );
        match msg {
            BunMessage::RosterSnapshot { agentes, mcp_servers } => {
                let a = &agentes[0];
                assert_eq!(a.alias, "Hormiga-01");
                assert_eq!(a.funcion, "");
                assert!(a.mcp.is_empty());
                assert!(mcp_servers.is_empty());
            }
            other => panic!("esperaba roster_snapshot, llegó {other:?}"),
        }
    }

    // ── Preexistentes ──────────────────────────────────────────────────────

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

    #[test]
    fn worker_update_keeps_new_dashboard_fields_optional() {
        let raw = r#"{"type":"worker_update","worker":"backend","phase":"editing","status":"running"}"#;
        let msg = sonic_rs::from_str::<BunMessage>(raw).unwrap();

        match msg {
            BunMessage::WorkerUpdate {
                worker,
                level,
                current_action,
                current_file,
                iteration_current,
                iteration_total,
                transversal,
                ..
            } => {
                assert_eq!(worker, "backend");
                assert_eq!(level, None);
                assert_eq!(current_action, None);
                assert_eq!(current_file, None);
                assert_eq!(iteration_current, None);
                assert_eq!(iteration_total, None);
                assert_eq!(transversal, None);
            }
            _ => panic!("expected worker_update"),
        }
    }

    #[test]
    fn dashboard_snapshot_deserializes_full_payload() {
        let raw = r#"{
            "type":"dashboard_snapshot",
            "workers":[{
                "name":"backend",
                "status":"running",
                "detail":"editing",
                "display_name":"BackendEngineer",
                "activity":"implementando refresh token",
                "token_count":12000,
                "level":2,
                "current_action":"escribiendo handler",
                "current_file":"src/auth.ts",
                "iteration_current":2,
                "iteration_total":5,
                "transversal":false
            }],
            "blackboard_events":[{
                "timestamp":"12:00:00",
                "agent":"architecture",
                "event_type":"DECISION",
                "content":"mantener contrato"
            }],
            "conflicts":[{
                "agent_a":"backend",
                "agent_b":"frontend",
                "file":"src/auth.ts",
                "reason":"edicion simultanea",
                "severity":"high"
            }],
            "levels":[{
                "level":2,
                "label":"ENG",
                "agents":["backend"],
                "status":"active"
            }],
            "checkpoints":[{
                "checkpoint_id":"cp_1",
                "description":"antes de editar auth",
                "file_count":2,
                "agent":"backend",
                "time":"12:00:01"
            }],
            "metrics":{"token_count":12000,"cost":"$0.04","elapsed_secs":61},
            "security":{"status":"WATCHING","findings":0},
            "halt":{"active":false}
        }"#;
        let msg = sonic_rs::from_str::<BunMessage>(raw).unwrap();

        match msg {
            BunMessage::DashboardSnapshot {
                workers,
                blackboard_events,
                conflicts,
                levels,
                checkpoints,
                metrics,
                security,
                halt,
            } => {
                assert_eq!(workers.len(), 1);
                assert_eq!(workers[0].current_action.as_deref(), Some("escribiendo handler"));
                assert_eq!(workers[0].iteration_total, Some(5));
                assert_eq!(blackboard_events[0].event_type, "DECISION");
                assert_eq!(conflicts[0].file.as_deref(), Some("src/auth.ts"));
                assert_eq!(levels[0].level, 2);
                assert_eq!(checkpoints[0].id, "cp_1");
                assert_eq!(metrics.unwrap().elapsed_secs, Some(61));
                assert_eq!(security.unwrap().status, "WATCHING");
                assert!(!halt.unwrap().active);
            }
            _ => panic!("expected dashboard_snapshot"),
        }
    }
}
