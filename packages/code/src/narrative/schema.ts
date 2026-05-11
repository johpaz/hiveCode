export const CODE_SCHEMA = `
-- Sessions: project session tracking
CREATE TABLE IF NOT EXISTS code_sessions (
  id          TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_active TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_code_sessions_active ON code_sessions(last_active);

-- Session mode change history
CREATE TABLE IF NOT EXISTS code_session_modes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES code_sessions(id),
  task_id         TEXT,
  mode            TEXT CHECK(mode IN ('plan','approval','auto')) NOT NULL,
  changed_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  phase_at_change TEXT,
  triggered_by    TEXT DEFAULT 'cli'
);
CREATE INDEX IF NOT EXISTS idx_code_session_modes_sess ON code_session_modes(session_id);

-- Tasks: coding tasks managed by the coordinator system
CREATE TABLE IF NOT EXISTS code_tasks (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES code_sessions(id),
  description  TEXT NOT NULL,
  status       TEXT CHECK(status IN ('pending','planning','running','paused','completed','failed','cancelled')),
  mode         TEXT CHECK(mode IN ('plan','approval','auto')),
  branch_name  TEXT,
  pr_url       TEXT,
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_code_tasks_session ON code_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_code_tasks_status ON code_tasks(status);

-- Task phases: breakdown of each task into coordinator phases
CREATE TABLE IF NOT EXISTS code_task_phases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL REFERENCES code_tasks(id),
  phase_name     TEXT NOT NULL,
  coordinator    TEXT NOT NULL,
  status         TEXT CHECK(status IN ('pending','running','completed','skipped','failed')),
  result_summary TEXT,
  approved_at    TEXT,
  approved_by    TEXT DEFAULT 'auto',
  started_at     TEXT,
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_code_phases_task ON code_task_phases(task_id);

-- Narrative: structured story of what happened per phase
CREATE TABLE IF NOT EXISTS code_narrative (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT REFERENCES code_tasks(id),
  session_id  TEXT REFERENCES code_sessions(id),
  coordinator TEXT NOT NULL,
  phase       TEXT,
  entry       TEXT NOT NULL,
  is_draft    INTEGER DEFAULT 0,
  is_override INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_code_narrative_task ON code_narrative(task_id);
CREATE INDEX IF NOT EXISTS idx_code_narrative_session ON code_narrative(session_id);
CREATE INDEX IF NOT EXISTS idx_code_narrative_coord ON code_narrative(coordinator);

CREATE VIRTUAL TABLE IF NOT EXISTS code_narrative_fts
  USING fts5(entry, content=code_narrative, content_rowid=id);

-- Decisions (ADRs)
CREATE TABLE IF NOT EXISTS code_decisions (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES code_tasks(id),
  title        TEXT NOT NULL,
  context      TEXT NOT NULL,
  options      TEXT NOT NULL,
  decision     TEXT NOT NULL,
  consequences TEXT NOT NULL,
  status       TEXT CHECK(status IN ('active','superseded','deprecated')) DEFAULT 'active',
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_code_decisions_task ON code_decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_code_decisions_status ON code_decisions(status);

-- File snapshots for rollback
CREATE TABLE IF NOT EXISTS code_file_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES code_tasks(id),
  file_path    TEXT NOT NULL,
  content      TEXT NOT NULL,
  hash         TEXT NOT NULL,
  snapshot_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_code_snapshots_task ON code_file_snapshots(task_id);

-- Traces: per-tool execution tracing (separate from ACE traces)
CREATE TABLE IF NOT EXISTS code_traces (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT REFERENCES code_tasks(id),
  agent_id       TEXT NOT NULL,
  coordinator    TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  input_summary  TEXT,
  output_summary TEXT,
  success        INTEGER DEFAULT 1,
  duration_ns    INTEGER,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  analyzed       INTEGER DEFAULT 0,
  created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_code_traces_task ON code_traces(task_id);
CREATE INDEX IF NOT EXISTS idx_code_traces_analyzed ON code_traces(analyzed) WHERE analyzed = 0;

-- Playbook: learned rules (separate from ACE playbook)
CREATE TABLE IF NOT EXISTS code_playbook (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule          TEXT NOT NULL,
  coordinator   TEXT,
  helpful_count INTEGER DEFAULT 0,
  harmful_count INTEGER DEFAULT 0,
  confidence    REAL DEFAULT 0.5,
  active        INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_applied  TEXT
);
CREATE INDEX IF NOT EXISTS idx_code_playbook_active ON code_playbook(active);

CREATE VIRTUAL TABLE IF NOT EXISTS code_playbook_fts
  USING fts5(rule, content=code_playbook, content_rowid=id);

-- Reflections: ACE-style reflections for code tasks
CREATE TABLE IF NOT EXISTS code_reflections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  traces_analyzed INTEGER NOT NULL,
  insights        TEXT NOT NULL,
  ethics_violation INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Context cache: compiled context with TTL
CREATE TABLE IF NOT EXISTS code_context_cache (
  cache_key   TEXT PRIMARY KEY,
  compiled    TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_code_cache_expires ON code_context_cache(expires_at);
`;
