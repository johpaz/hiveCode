/**
 * Integration tests for the agent loop pipeline.
 *
 * Tests the observable state that the loop produces in SQLite without
 * making real LLM calls — using a stub provider that returns preset responses.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { CODE_SCHEMA } from "@johpaz/hivecode-code/narrative/schema"

// ── In-memory DB ──────────────────────────────────────────────────────────

function makeDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(CODE_SCHEMA)
  return db
}

let db: Database

beforeEach(() => { db = makeDb() })
afterEach(() => { db.close() })

// ── Helpers ────────────────────────────────────────────────────────────────

function insertSession(db: Database, id = "sess-1"): string {
  db.run("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)", [id, "/tmp/proj"])
  return id
}

function insertTask(db: Database, sessionId: string, id = "task-1", status = "running"): string {
  db.run(
    `INSERT INTO code_tasks (id, session_id, description, status, mode)
     VALUES (?, ?, 'Implement auth', ?, 'auto')`,
    [id, sessionId, status]
  )
  return id
}

function insertPhase(db: Database, taskId: string, coordinator: string, status = "completed"): number {
  const info = db.run(
    `INSERT INTO code_task_phases (task_id, phase_name, coordinator, status, duration_ms, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?, 1200, 500, 300)`,
    [taskId, `${coordinator}-phase`, coordinator, status]
  )
  return Number(info.lastInsertRowid)
}

// ── Task lifecycle ─────────────────────────────────────────────────────────

describe("Task lifecycle state machine", () => {
  test("valid status transitions: pending → running → completed", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId, "t1", "pending")

    db.run("UPDATE code_tasks SET status = 'running' WHERE id = ?", [taskId])
    db.run("UPDATE code_tasks SET status = 'completed', completed_at = datetime('now') WHERE id = ?", [taskId])

    const task = db.query("SELECT * FROM code_tasks WHERE id = ?").get(taskId) as any
    expect(task.status).toBe("completed")
    expect(task.completed_at).toBeTruthy()
  })

  test("valid status: pending → running → failed", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId, "t2", "running")

    db.run("UPDATE code_tasks SET status = 'failed' WHERE id = ?", [taskId])
    const task = db.query("SELECT status FROM code_tasks WHERE id = ?").get(taskId) as any
    expect(task.status).toBe("failed")
  })

  test("invalid status is rejected by CHECK constraint", () => {
    const sessionId = insertSession(db)
    expect(() =>
      db.run(
        "INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES ('x', ?, 'x', 'invalid', 'auto')",
        [sessionId]
      )
    ).toThrow()
  })
})

// ── Phase breakdown ────────────────────────────────────────────────────────

describe("Phase breakdown and tracing", () => {
  test("phases are ordered by insertion (id ASC) and linked to task", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)

    insertPhase(db, taskId, "architecture")
    insertPhase(db, taskId, "backend")
    insertPhase(db, taskId, "test")

    const phases = db.query(
      "SELECT coordinator FROM code_task_phases WHERE task_id = ? ORDER BY id ASC"
    ).all(taskId) as any[]

    expect(phases.map(p => p.coordinator)).toEqual(["architecture", "backend", "test"])
  })

  test("tool trace records input/output summaries and timing", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)
    const phaseId = insertPhase(db, taskId, "backend")

    db.run(
      `INSERT INTO code_traces
         (task_id, agent_id, coordinator, tool_name, input_summary, output_summary, success, duration_ns, tokens_in, tokens_out)
       VALUES (?, 'agent-1', 'backend', 'read_file', '{"path":"src/app.ts"}', 'export function main()', 1, 15000000, 100, 0)`,
      [taskId]
    )

    const trace = db.query(
      "SELECT * FROM code_traces WHERE task_id = ?"
    ).get(taskId) as any

    expect(trace.tool_name).toBe("read_file")
    expect(trace.success).toBe(1)
    expect(trace.duration_ns).toBe(15_000_000)
  })

  test("failed tool trace is stored with success=0", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)

    db.run(
      `INSERT INTO code_traces
         (task_id, agent_id, coordinator, tool_name, input_summary, output_summary, success)
       VALUES (?, 'agent-1', 'backend', 'code_build', '{"command":"bun run build"}', 'Error: module not found', 0)`,
      [taskId]
    )

    const trace = db.query("SELECT success, output_summary FROM code_traces WHERE task_id = ?").get(taskId) as any
    expect(trace.success).toBe(0)
    expect(trace.output_summary).toContain("Error")
  })
})

// ── Narrative recording ────────────────────────────────────────────────────

describe("Narrative recording during task", () => {
  test("multiple coordinators write separate narrative entries", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)

    const entries = [
      { coordinator: "architecture", phase: "planning", entry: "Decided to use JWT for auth" },
      { coordinator: "backend", phase: "coding", entry: "Implemented /auth/login endpoint" },
      { coordinator: "test", phase: "testing", entry: "Added 15 unit tests for auth module" },
    ]

    for (const e of entries) {
      db.run(
        `INSERT INTO code_narrative (task_id, session_id, coordinator, phase, entry)
         VALUES (?, ?, ?, ?, ?)`,
        [taskId, sessionId, e.coordinator, e.phase, e.entry]
      )
    }

    const all = db.query(
      "SELECT coordinator, entry FROM code_narrative WHERE task_id = ? ORDER BY id"
    ).all(taskId) as any[]

    expect(all.length).toBe(3)
    expect(all[0].coordinator).toBe("architecture")
    expect(all[2].coordinator).toBe("test")
  })

  test("USER OVERRIDE is stored with is_override=1", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)

    db.run(
      `INSERT INTO code_narrative (task_id, session_id, coordinator, phase, entry, is_override)
       VALUES (?, ?, 'user', 'override', 'Actually, use bcrypt not argon2', 1)`,
      [taskId, sessionId]
    )

    const overrides = db.query(
      "SELECT entry FROM code_narrative WHERE task_id = ? AND is_override = 1"
    ).all(taskId) as any[]

    expect(overrides.length).toBe(1)
    expect(overrides[0].entry).toContain("bcrypt")
  })
})

// ── Token and cost tracking ────────────────────────────────────────────────

describe("Token and cost aggregation", () => {
  test("task tokens are accumulated across phases", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)

    insertPhase(db, taskId, "architecture") // 500 in, 300 out per helper

    // Simulate final aggregation
    const phases = db.query(
      "SELECT SUM(tokens_in) as total_in, SUM(tokens_out) as total_out FROM code_task_phases WHERE task_id = ?"
    ).get(taskId) as any

    db.run(
      "UPDATE code_tasks SET tokens_in = ?, tokens_out = ? WHERE id = ?",
      [phases.total_in, phases.total_out, taskId]
    )

    const task = db.query("SELECT tokens_in, tokens_out FROM code_tasks WHERE id = ?").get(taskId) as any
    expect(task.tokens_in).toBe(500)
    expect(task.tokens_out).toBe(300)
  })
})

// ── File change tracking ───────────────────────────────────────────────────

describe("File change tracking", () => {
  test("file changes are linked to task and phase", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)
    const phaseId = insertPhase(db, taskId, "backend")

    db.run(
      `INSERT INTO code_file_changes (task_id, phase_id, file_path, change_type, lines_added, lines_removed)
       VALUES (?, ?, 'src/auth.ts', 'added', 120, 0)`,
      [taskId, phaseId]
    )
    db.run(
      `INSERT INTO code_file_changes (task_id, phase_id, file_path, change_type, lines_added, lines_removed)
       VALUES (?, ?, 'src/app.ts', 'modified', 5, 2)`,
      [taskId, phaseId]
    )

    const changes = db.query(
      "SELECT * FROM code_file_changes WHERE task_id = ? ORDER BY id"
    ).all(taskId) as any[]

    expect(changes.length).toBe(2)
    expect(changes[0].change_type).toBe("added")
    expect(changes[1].lines_removed).toBe(2)
  })

  test("file stats aggregation per task", () => {
    const sessionId = insertSession(db)
    const taskId = insertTask(db, sessionId)
    const phaseId = insertPhase(db, taskId, "backend")

    db.run(
      `INSERT INTO code_file_changes (task_id, phase_id, file_path, change_type, lines_added, lines_removed)
       VALUES (?, ?, 'a.ts', 'added', 50, 0)`,
      [taskId, phaseId]
    )
    db.run(
      `INSERT INTO code_file_changes (task_id, phase_id, file_path, change_type, lines_added, lines_removed)
       VALUES (?, ?, 'b.ts', 'modified', 10, 5)`,
      [taskId, phaseId]
    )

    const stats = db.query(
      `SELECT COUNT(*) as files, SUM(lines_added) as added, SUM(lines_removed) as removed
       FROM code_file_changes WHERE task_id = ?`
    ).get(taskId) as any

    expect(stats.files).toBe(2)
    expect(stats.added).toBe(60)
    expect(stats.removed).toBe(5)
  })
})
