import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SCHEMA, PROJECTS_SCHEMA, CONTEXT_ENGINE_SCHEMA, MEETING_SCHEMA } from "@johpaz/hivecode-core/storage/schema"
import { _setDb, _resetDb } from "@johpaz/hivecode-core/storage/sqlite"
import { resetConfig } from "@johpaz/hivecode-core/config/loader"
import { CODE_SCHEMA } from "@johpaz/hivecode-code/narrative/schema"

export interface RealTestSetup {
  tmpDir: string
  db: Database
  cleanup: () => void
}

/**
 * Creates an isolated HIVE_HOME for real API tests.
 *
 * MUST be called after initSessionArray() and BEFORE new CoordinatorManager(),
 * because it sets process.env.HIVE_HOME which Bun Worker threads inherit at
 * creation time (inside startAll).
 *
 * Sequence: initSessionArray() → setupRealHiveHome() → new CoordinatorManager() → startAll()
 */
export function setupRealHiveHome(): RealTestSetup {
  const tmpDir = mkdtempSync(join(tmpdir(), "hivecode-real-"))

  mkdirSync(join(tmpDir, "data"), { recursive: true })
  mkdirSync(join(tmpDir, "sessions"), { recursive: true })
  mkdirSync(join(tmpDir, "workspaces"), { recursive: true })

  // Must be set BEFORE startAll() — workers inherit process.env at thread creation
  process.env.HIVE_HOME = tmpDir

  const dbPath = join(tmpDir, "data", "hivecode.db")
  const db = new Database(dbPath, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA synchronous = NORMAL")

  db.run(SCHEMA)
  db.run(PROJECTS_SCHEMA)
  db.run(CONTEXT_ENGINE_SCHEMA)
  db.run(MEETING_SCHEMA)
  db.run(CODE_SCHEMA)

  // Seed the configured provider so loadSecrets() finds it and looks up Bun.secrets
  db.query(
    "INSERT OR REPLACE INTO providers (id, name, base_url, enabled) VALUES (?, ?, ?, ?)"
  ).run("opencode-go", "opencode-go", null, 1)

  // runTask reads these two keys at lines 429-434 of coordinator-manager.ts
  db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)").run("default_provider", "opencode-go")
  db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)").run("provider_model_opencode-go", "opencode-go/minimax-m2.5")

  // Wire main-thread DB singleton (Scribe, tools, all getDb() callers in main thread)
  _setDb(db)

  const cleanup = () => {
    try { db.close() } catch { /* already closed */ }
    _resetDb()
    resetConfig()
    delete process.env.HIVE_HOME
    rmSync(tmpDir, { recursive: true, force: true })
  }

  return { tmpDir, db, cleanup }
}

/** Helper: get the most recently created task from the test DB */
export function getLastTask(db: Database): { id: string; status: string; mode: string; duration_ms: number } | null {
  return db.query(
    "SELECT id, status, mode, duration_ms FROM code_tasks ORDER BY created_at DESC LIMIT 1"
  ).get() as any
}

/** Helper: get all phases for a task */
export function getTaskPhases(db: Database, taskId: string): { coordinator: string; status: string }[] {
  return db.query(
    "SELECT coordinator, status FROM code_task_phases WHERE task_id = ? ORDER BY id ASC"
  ).all(taskId) as any[]
}

/** Helper: get decisions (ADRs) for a task */
export function getTaskDecisions(db: Database, taskId: string): { title: string; decision: string }[] {
  return db.query(
    "SELECT title, decision FROM code_decisions WHERE task_id = ? ORDER BY created_at ASC"
  ).all(taskId) as any[]
}

/** Helper: get narrative entries for a task */
export function getTaskNarrative(db: Database, taskId: string): { coordinator: string; entry: string }[] {
  return db.query(
    "SELECT coordinator, entry FROM code_narrative WHERE task_id = ? ORDER BY id ASC"
  ).all(taskId) as any[]
}

/** Helper: get all tasks in a session */
export function getSessionTasks(db: Database, sessionId: string): { id: string; status: string; mode: string }[] {
  return db.query(
    "SELECT id, status, mode FROM code_tasks WHERE session_id = ? ORDER BY created_at ASC"
  ).all(sessionId) as any[]
}
