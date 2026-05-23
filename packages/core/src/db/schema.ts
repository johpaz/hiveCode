// Schema por sesión — una DB por sesión en ~/.hivecode/sessions/<session_id>.db
// Cada statement es ejecutado en orden dentro de una transacción en applySchema().

export const SESSION_SCHEMA: string[] = [

  // ─── SESIONES ────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT    PRIMARY KEY,
    project_path  TEXT    NOT NULL,
    project_name  TEXT    NOT NULL,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    mode          TEXT    NOT NULL DEFAULT 'plan',
    provider      TEXT    NOT NULL,
    model         TEXT    NOT NULL,
    version       TEXT    NOT NULL,
    token_count   INTEGER DEFAULT 0,
    cost_usd      REAL    DEFAULT 0.0
  )`,

  // ─── HISTORIAL DE MENSAJES ───────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL REFERENCES sessions(id),
    role          TEXT    NOT NULL,
    agent         TEXT,
    content       TEXT    NOT NULL,
    content_type  TEXT    DEFAULT 'text',
    created_at    INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id, created_at)`,

  // ─── AGENT CONTEXT (BLACKBOARD) ──────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS agent_context (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL REFERENCES sessions(id),
    agent         TEXT    NOT NULL,
    type          TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active',
    scope         TEXT    DEFAULT 'session',
    file_path     TEXT,
    parent_id     INTEGER REFERENCES agent_context(id),
    resolved_by   TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_ctx_session_active
    ON agent_context(session_id, status, type)`,

  `CREATE INDEX IF NOT EXISTS idx_ctx_file
    ON agent_context(session_id, file_path)
    WHERE file_path IS NOT NULL`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS agent_context_fts USING fts5(
    content,
    agent,
    type,
    content='agent_context',
    content_rowid='id'
  )`,

  // ─── AGENT CONFLICTS ─────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS agent_conflicts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL REFERENCES sessions(id),
    agent_a       TEXT    NOT NULL,
    agent_b       TEXT    NOT NULL,
    type          TEXT    NOT NULL,
    description   TEXT    NOT NULL,
    file_path     TEXT,
    context_id_a  INTEGER REFERENCES agent_context(id),
    context_id_b  INTEGER REFERENCES agent_context(id),
    severity      TEXT    NOT NULL DEFAULT 'medium',
    resolved      INTEGER NOT NULL DEFAULT 0,
    resolved_by   TEXT,
    resolution    TEXT,
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_conflicts_unresolved
    ON agent_conflicts(session_id, resolved)
    WHERE resolved = 0`,

  // ─── AGENT AWARENESS ─────────────────────────────────────────────────────────
  // Fix Bug-D: observer siempre es 'bee' en v1. PK triple anticipa
  // futuros observadores múltiples (workers observándose entre sí en v2).
  `CREATE TABLE IF NOT EXISTS agent_awareness (
    session_id        TEXT    NOT NULL REFERENCES sessions(id),
    observer          TEXT    NOT NULL,
    observed          TEXT    NOT NULL,
    phase             TEXT,
    status            TEXT,
    last_known_action TEXT,
    last_known_file   TEXT,
    pending_question  INTEGER REFERENCES agent_context(id),
    confidence        REAL    DEFAULT 1.0,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (session_id, observer, observed)
  )`,

  // ─── CHECKPOINTS ─────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS checkpoints (
    id            TEXT    PRIMARY KEY,
    session_id    TEXT    NOT NULL REFERENCES sessions(id),
    created_by    TEXT    NOT NULL,
    description   TEXT    NOT NULL,
    file_count    INTEGER NOT NULL DEFAULT 0,
    git_stash_ref TEXT,
    created_at    INTEGER NOT NULL,
    restored_at   INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS checkpoint_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    checkpoint_id TEXT    NOT NULL REFERENCES checkpoints(id),
    file_path     TEXT    NOT NULL,
    content       BLOB    NOT NULL,
    content_hash  TEXT    NOT NULL,
    operation     TEXT    NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_cp_session
    ON checkpoints(session_id, created_at DESC)`,

  // ─── ADRs ────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS adrs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path     TEXT    NOT NULL UNIQUE,
    title         TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'accepted',
    content       TEXT    NOT NULL,
    summary       TEXT,
    updated_at    INTEGER NOT NULL
  )`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS adrs_fts USING fts5(
    title,
    content,
    content='adrs',
    content_rowid='id'
  )`,

  // ─── FILE RISKS ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS file_risks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL REFERENCES sessions(id),
    file_path     TEXT    NOT NULL,
    risk_level    TEXT    NOT NULL,
    operation     TEXT,
    adr_ref       TEXT,
    reason        TEXT,
    agent         TEXT,
    updated_at    INTEGER NOT NULL,
    UNIQUE (session_id, file_path)
  )`,

  // ─── WORKER ACTIVITY ─────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS worker_activity (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL REFERENCES sessions(id),
    worker        TEXT    NOT NULL,
    phase         TEXT    NOT NULL,
    level         INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL,
    current_action TEXT,
    input_tokens  INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    started_at    INTEGER,
    completed_at  INTEGER
  )`,

  // ─── VISTA: estado mental de Bee ─────────────────────────────────────────────
  // Fix Bug-C: session_id expuesto en SELECT — consultar siempre con
  // WHERE session_id = ? para evitar mezclar sesiones.
  `CREATE VIEW IF NOT EXISTS bee_awareness AS
  SELECT
    aa.session_id,
    aa.observed                                   AS worker,
    aa.phase,
    aa.status,
    aa.last_known_action,
    aa.last_known_file,
    aa.confidence,
    (SELECT content FROM agent_context
     WHERE session_id = aa.session_id
     AND   agent      = aa.observed
     AND   type       = 'decision'
     AND   status     = 'active'
     ORDER BY created_at DESC LIMIT 1)            AS last_decision,
    EXISTS (
      SELECT 1 FROM agent_conflicts
      WHERE session_id = aa.session_id
      AND   (agent_a   = aa.observed OR agent_b = aa.observed)
      AND   resolved   = 0
    )                                             AS has_conflict,
    (SELECT COUNT(*) FROM agent_conflicts
     WHERE session_id = aa.session_id
     AND   (agent_a   = aa.observed OR agent_b = aa.observed)
     AND   resolved   = 0)                        AS conflict_count
  FROM agent_awareness aa
  WHERE aa.observer = 'bee'`,
]
