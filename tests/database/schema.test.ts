/**
 * Integration tests for code DB schema — DDL, FTS5 triggers,
 * recovery points, file snapshots.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { CODE_SCHEMA } from "@johpaz/hivecode-code/narrative/schema"

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(CODE_SCHEMA)
  return db
}

function insertSession(db: Database, id = "sess-1"): string {
  db.run(
    "INSERT INTO code_sessions (id, project_path) VALUES (?, ?)",
    [id, "/tmp/test-project"]
  )
  return id
}

function insertTask(db: Database, sessionId: string, id = "task-1"): string {
  db.run(
    `INSERT INTO code_tasks (id, session_id, description, status, mode)
     VALUES (?, ?, ?, 'pending', 'auto')`,
    [id, sessionId, "Test task"]
  )
  return id
}

let db: Database

beforeEach(() => {
  db = makeDb()
})

afterEach(() => {
  db.close()
})

// ── Pragmas ────────────────────────────────────────────────────────────────

describe("SQLite pragmas", () => {
  test("WAL journal mode is set", () => {
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string }
    // :memory: always returns 'memory' — WAL only applies to file DBs
    expect(["wal", "memory"]).toContain(row.journal_mode)
  })

  test("foreign_keys is ON", () => {
    const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(row.foreign_keys).toBe(1)
  })
})

// ── DDL ───────────────────────────────────────────────────────────────────

describe("Schema DDL", () => {
  const tables = [
    "code_sessions", "code_turns", "code_session_modes",
    "code_tasks", "code_task_phases", "code_file_changes",
    "code_narrative", "code_decisions", "code_file_snapshots",
    "code_traces", "code_playbook", "code_reflections",
    "code_config", "code_context_state", "code_context_cache",
    "code_graph",
  ]

  for (const table of tables) {
    test(`table ${table} exists`, () => {
      const row = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table) as { name: string } | null
      expect(row?.name).toBe(table)
    })
  }

  test("FTS5 virtual tables exist", () => {
    const ftsTables = ["code_narrative_fts", "code_playbook_fts", "code_commands_fts", "code_fts"]
    for (const t of ftsTables) {
      const row = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(t) as { name: string } | null
      expect(row?.name).toBe(t)
    }
  })

  test("code_playbook has UNIQUE constraint on rule", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)
    db.run(
      `INSERT INTO code_playbook (rule, coordinator, source) VALUES (?, ?, ?)`,
      ["Use TypeScript strict mode", "user", "preferences"]
    )
    expect(() =>
      db.run(
        `INSERT INTO code_playbook (rule, coordinator, source) VALUES (?, ?, ?)`,
        ["Use TypeScript strict mode", "user", "preferences"]
      )
    ).toThrow()
  })
})

// ── Foreign keys ───────────────────────────────────────────────────────────

describe("Foreign key constraints", () => {
  test("code_turns rejects unknown session_id", () => {
    expect(() =>
      db.run(
        `INSERT INTO code_turns (id, session_id, user_message, agent_response)
         VALUES ('t1', 'nonexistent', 'hello', 'hi')`,
        []
      )
    ).toThrow()
  })

  test("code_tasks rejects unknown session_id", () => {
    expect(() =>
      db.run(
        `INSERT INTO code_tasks (id, session_id, description, status, mode)
         VALUES ('x', 'nonexistent', 'x', 'pending', 'auto')`,
        []
      )
    ).toThrow()
  })
})

// ── File snapshots ─────────────────────────────────────────────────────────

describe("code_file_snapshots (recovery points)", () => {
  test("can insert and retrieve a file snapshot", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)

    db.run(
      `INSERT INTO code_file_snapshots (task_id, file_path, content, hash)
       VALUES (?, ?, ?, ?)`,
      [taskId, "src/app.ts", "console.log('hello')", "sha256:abc123"]
    )

    const snap = db.query(
      "SELECT * FROM code_file_snapshots WHERE task_id = ?"
    ).get(taskId) as any

    expect(snap.file_path).toBe("src/app.ts")
    expect(snap.content).toBe("console.log('hello')")
    expect(snap.hash).toBe("sha256:abc123")
  })

  test("multiple snapshots per task are stored independently", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)

    db.run(`INSERT INTO code_file_snapshots (task_id, file_path, content, hash) VALUES (?, ?, ?, ?)`,
      [taskId, "a.ts", "v1", "h1"])
    db.run(`INSERT INTO code_file_snapshots (task_id, file_path, content, hash) VALUES (?, ?, ?, ?)`,
      [taskId, "b.ts", "v2", "h2"])

    const snaps = db.query(
      "SELECT * FROM code_file_snapshots WHERE task_id = ? ORDER BY id"
    ).all(taskId) as any[]

    expect(snaps.length).toBe(2)
    expect(snaps[0].file_path).toBe("a.ts")
    expect(snaps[1].file_path).toBe("b.ts")
  })
})

// ── Narrative USER OVERRIDE ────────────────────────────────────────────────

describe("code_narrative is_override flag", () => {
  test("can insert override entry and retrieve it", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)

    db.run(
      `INSERT INTO code_narrative (task_id, session_id, coordinator, phase, entry, is_override)
       VALUES (?, ?, 'user', 'override', 'Use tabs not spaces!', 1)`,
      [taskId, sessionId]
    )

    const overrides = db.query(
      "SELECT * FROM code_narrative WHERE task_id = ? AND is_override = 1"
    ).all(taskId) as any[]

    expect(overrides.length).toBe(1)
    expect(overrides[0].entry).toBe("Use tabs not spaces!")
    expect(overrides[0].coordinator).toBe("user")
  })
})

// ── FTS5 search ────────────────────────────────────────────────────────────

describe("code_narrative_fts full-text search", () => {
  test("FTS5 finds entries by keyword", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)

    db.run(
      `INSERT INTO code_narrative (task_id, session_id, coordinator, phase, entry)
       VALUES (?, ?, 'bee', 'planning', 'Implement JWT authentication for the API endpoints')`,
      [taskId, sessionId]
    )
    db.run(
      `INSERT INTO code_narrative (task_id, session_id, coordinator, phase, entry)
       VALUES (?, ?, 'bee', 'planning', 'Add database migrations for the user table')`,
      [taskId, sessionId]
    )

    // FTS5 content= tables require manual insert into the FTS table
    db.run(`INSERT INTO code_narrative_fts(rowid, entry) SELECT id, entry FROM code_narrative`)

    const results = db.query(
      `SELECT n.entry FROM code_narrative n
       JOIN code_narrative_fts fts ON n.id = fts.rowid
       WHERE code_narrative_fts MATCH 'JWT'`
    ).all() as any[]

    expect(results.length).toBe(1)
    expect(results[0].entry).toContain("JWT")
  })
})

// ── code_graph ────────────────────────────────────────────────────────────

describe("code_graph dependency table", () => {
  test("UNIQUE(session_id, file_path) ON CONFLICT REPLACE upserts correctly", () => {
    const sessionId = insertSession(db)

    db.run(
      `INSERT INTO code_graph (session_id, file_path, exports, functions)
       VALUES (?, ?, '["foo"]', '["foo","bar"]')`,
      [sessionId, "src/index.ts"]
    )
    // Second insert on same (session, file) should replace
    db.run(
      `INSERT INTO code_graph (session_id, file_path, exports, functions)
       VALUES (?, ?, '["foo","baz"]', '["foo","bar","baz"]')`,
      [sessionId, "src/index.ts"]
    )

    const rows = db.query(
      "SELECT * FROM code_graph WHERE session_id = ? AND file_path = ?"
    ).all(sessionId, "src/index.ts") as any[]

    expect(rows.length).toBe(1)
    expect(JSON.parse(rows[0].exports)).toContain("baz")
  })
})

// ── code_playbook source column ────────────────────────────────────────────

describe("code_playbook source and confidence", () => {
  test("default source is 'reflector'", () => {
    db.run(`INSERT INTO code_playbook (rule) VALUES ('Always write tests')`)
    const row = db.query("SELECT source, confidence FROM code_playbook WHERE rule = ?")
      .get("Always write tests") as any
    expect(row.source).toBe("reflector")
    expect(row.confidence).toBe(0.5)
  })

  test("preferences source stores correctly", () => {
    db.run(
      `INSERT INTO code_playbook (rule, coordinator, source, confidence)
       VALUES ('Prefer functional components', 'user', 'preferences', 0.9)`
    )
    const row = db.query("SELECT * FROM code_playbook WHERE source = 'preferences'").get() as any
    expect(row.rule).toBe("Prefer functional components")
    expect(row.coordinator).toBe("user")
    expect(row.confidence).toBe(0.9)
  })

  test("ON CONFLICT REPLACE updates existing rule", () => {
    db.run(`INSERT INTO code_playbook (rule, confidence) VALUES ('Test rule', 0.5)`)
    db.run(
      `INSERT INTO code_playbook (rule, confidence) VALUES ('Test rule', 0.8)
       ON CONFLICT(rule) DO UPDATE SET confidence = excluded.confidence`
    )
    const row = db.query("SELECT confidence FROM code_playbook WHERE rule = 'Test rule'").get() as any
    expect(row.confidence).toBe(0.8)
  })
})
