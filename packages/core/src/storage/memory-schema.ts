// Schema para la base de datos global de memoria de agentes: ~/.hivecode/memory.db
// Persiste entre sesiones — fuente de verdad única para el conocimiento acumulado del enjambre.

export const MEMORY_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS agent_memory (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    session_origin  TEXT    NOT NULL,
    agent           TEXT    NOT NULL,
    type            TEXT    NOT NULL CHECK(type IN ('pattern','antipattern','contract','convention','forensic_lesson')),
    content         TEXT    NOT NULL,
    severity        TEXT    NOT NULL DEFAULT 'medium' CHECK(severity IN ('critical','high','medium','low')),
    confirmed_count INTEGER NOT NULL DEFAULT 0,
    refuted_count   INTEGER NOT NULL DEFAULT 0,
    last_used_at    INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    deprecated      INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE INDEX IF NOT EXISTS idx_mem_project
    ON agent_memory(project_id, deprecated, severity)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
    content,
    type,
    agent,
    content='agent_memory',
    content_rowid='id'
  )`,

  `CREATE TRIGGER IF NOT EXISTS agent_memory_ai
    AFTER INSERT ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(rowid, content, type, agent)
      VALUES (new.id, new.content, new.type, new.agent);
    END`,

  `CREATE TRIGGER IF NOT EXISTS agent_memory_ad
    AFTER DELETE ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(agent_memory_fts, rowid, content, type, agent)
      VALUES ('delete', old.id, old.content, old.type, old.agent);
    END`,

  `CREATE TRIGGER IF NOT EXISTS agent_memory_au
    AFTER UPDATE ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(agent_memory_fts, rowid, content, type, agent)
      VALUES ('delete', old.id, old.content, old.type, old.agent);
      INSERT INTO agent_memory_fts(rowid, content, type, agent)
      VALUES (new.id, new.content, new.type, new.agent);
    END`,
]
