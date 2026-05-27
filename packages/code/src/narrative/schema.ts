export const CODE_SCHEMA = `
-- Sessions: one per TUI open-close lifecycle
CREATE TABLE IF NOT EXISTS code_sessions (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  status       TEXT DEFAULT 'active' CHECK(status IN ('active','closed')),
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_active  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_code_sessions_active ON code_sessions(last_active);

-- Turns: every user↔agent exchange within a session
-- task_id is NULL when BEE responded directly (no code work needed)
CREATE TABLE IF NOT EXISTS code_turns (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES code_sessions(id),
  task_id        TEXT REFERENCES code_tasks(id),
  user_message   TEXT NOT NULL,
  agent_response TEXT NOT NULL DEFAULT '',
  created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_code_turns_session ON code_turns(session_id);

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

-- Tasks: coding tasks managed by the coordinator system (created only when BEE delegates work)
CREATE TABLE IF NOT EXISTS code_tasks (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES code_sessions(id),
  description   TEXT NOT NULL,
  status        TEXT CHECK(status IN ('pending','planning','running','paused','completed','failed','cancelled')),
  mode          TEXT CHECK(mode IN ('plan','approval','auto')),
  branch_name   TEXT,
  pr_url        TEXT,
  tokens_in     INTEGER DEFAULT 0,
  tokens_out    INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  lines_added   INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  duration_ms   INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  completed_at  TEXT
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
  tokens_in      INTEGER DEFAULT 0,
  tokens_out     INTEGER DEFAULT 0,
  duration_ms    INTEGER DEFAULT 0,
  started_at     TEXT,
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_code_phases_task ON code_task_phases(task_id);

-- File changes: per-task file modification tracking with line stats
CREATE TABLE IF NOT EXISTS code_file_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES code_tasks(id),
  phase_id      INTEGER REFERENCES code_task_phases(id),
  file_path     TEXT NOT NULL,
  change_type   TEXT CHECK(change_type IN ('added','modified','deleted')),
  lines_added   INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_code_file_changes_task ON code_file_changes(task_id);

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
  rule          TEXT NOT NULL UNIQUE,
  coordinator   TEXT,
  source        TEXT DEFAULT 'reflector',
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

-- Config: Hive-Code settings (default provider, models, etc.)
CREATE TABLE IF NOT EXISTS code_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Context state: current session state (active provider, model, mode, MCPs, skills)
CREATE TABLE IF NOT EXISTS code_context_state (
  session_id       TEXT PRIMARY KEY REFERENCES code_sessions(id) ON DELETE CASCADE,
  active_provider  TEXT DEFAULT 'anthropic',
  active_model     TEXT DEFAULT '',
  active_mode      TEXT DEFAULT 'auto' CHECK(active_mode IN ('plan','approval','auto')),
  active_mcp       TEXT DEFAULT '[]',
  active_skills    TEXT DEFAULT '[]',
  updated_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Commands FTS: autocomplete for internal slash commands
CREATE VIRTUAL TABLE IF NOT EXISTS code_commands_fts
  USING fts5(command, category, description);

-- Context cache: compiled context with TTL
CREATE TABLE IF NOT EXISTS code_context_cache (
  cache_key   TEXT PRIMARY KEY,
  compiled    TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_code_cache_expires ON code_context_cache(expires_at);

-- Code graph: dependency graph of the codebase (built at init, updated incrementally)
CREATE TABLE IF NOT EXISTS code_graph (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES code_sessions(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  imports       TEXT DEFAULT '[]',   -- JSON array of file paths this file imports
  exported_by   TEXT DEFAULT '[]',   -- JSON array of file paths that import this file
  exports       TEXT DEFAULT '[]',   -- JSON array of exported symbol names
  functions     TEXT DEFAULT '[]',   -- JSON array of function names
  classes       TEXT DEFAULT '[]',   -- JSON array of class names
  complexity    INTEGER DEFAULT 0,   -- cyclomatic complexity estimate
  last_modified TEXT,
  indexed_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(session_id, file_path) ON CONFLICT REPLACE
);
CREATE INDEX IF NOT EXISTS idx_code_graph_session ON code_graph(session_id);
CREATE INDEX IF NOT EXISTS idx_code_graph_file ON code_graph(file_path);

-- Recovery points: per-phase checkpoints to resume interrupted tasks
CREATE TABLE IF NOT EXISTS code_recovery_points (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT NOT NULL REFERENCES code_tasks(id),
  phase_id          INTEGER REFERENCES code_task_phases(id),
  level             INTEGER DEFAULT 0, -- execution level this checkpoint covers
  git_ref           TEXT,              -- commit hash at checkpoint time
  completed_phases  TEXT DEFAULT '[]', -- JSON array of completed phase IDs
  pending_phases    TEXT DEFAULT '[]', -- JSON array of remaining phase IDs
  last_narrative_id INTEGER,           -- rowid of last narrative entry
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_recovery_task ON code_recovery_points(task_id);

-- Learning failures: append-only log of every detected failure (tool, phase, output)
-- Never updated — new rows only. Feeds learning_proposals via pattern detection.
CREATE TABLE IF NOT EXISTS learning_failures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT REFERENCES code_tasks(id),
  phase_id        TEXT REFERENCES code_task_phases(id),
  agent           TEXT NOT NULL,
  failure_type    TEXT NOT NULL CHECK(failure_type IN ('tool_error','phase_failure','invalid_output','plan_drift','timeout')),
  error_message   TEXT NOT NULL,
  context_summary TEXT,
  resolved        INTEGER DEFAULT 0,
  resolution      TEXT,
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_lf_task  ON learning_failures(task_id);
CREATE INDEX IF NOT EXISTS idx_lf_agent ON learning_failures(agent, failure_type);

-- Learning proposals: improvement suggestions generated from failure patterns.
-- status='pending' has NO effect on the system — operator must approve manually.
CREATE TABLE IF NOT EXISTS learning_proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_agent  TEXT NOT NULL,
  proposal_type TEXT NOT NULL CHECK(proposal_type IN ('skill_adjust','new_skill','prompt_change','phase_order')),
  description   TEXT NOT NULL,
  failure_ids   TEXT NOT NULL DEFAULT '[]',
  status        TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_lp_status ON learning_proposals(status);
`;
