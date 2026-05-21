import { describe, it, expect, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { SESSION_SCHEMA } from "@johpaz/hivecode-core/db/schema"
import { SessionsRepo } from "@johpaz/hivecode-core/db/repos/sessions"
import { MessagesRepo } from "@johpaz/hivecode-core/db/repos/messages"
import { AgentContextRepo } from "@johpaz/hivecode-core/db/repos/agent-context"
import { AgentConflictsRepo } from "@johpaz/hivecode-core/db/repos/agent-conflicts"
import { AgentAwarenessRepo } from "@johpaz/hivecode-core/db/repos/agent-awareness"
import { CheckpointsRepo } from "@johpaz/hivecode-core/db/repos/checkpoints"
import { AdrsRepo } from "@johpaz/hivecode-core/db/repos/adrs"
import { FileRisksRepo } from "@johpaz/hivecode-core/db/repos/file-risks"

function makeTestDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.transaction(() => {
    for (const stmt of SESSION_SCHEMA) {
      db.run(stmt)
    }
  })()
  return db
}

const SESSION_ID = "test-session-001"
const NOW = Date.now()

describe("SESSION_SCHEMA — tablas creadas", () => {
  it("aplica el schema sin errores en :memory:", () => {
    expect(() => makeTestDb()).not.toThrow()
  })

  it("crea todas las tablas requeridas", () => {
    const db = makeTestDb()
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name)

    const required = [
      "sessions", "messages", "agent_context",
      "agent_conflicts", "agent_awareness",
      "checkpoints", "checkpoint_files",
      "adrs", "file_risks", "worker_activity",
    ]
    for (const t of required) {
      expect(tables).toContain(t)
    }
    db.close()
  })

  it("crea la vista bee_awareness", () => {
    const db = makeTestDb()
    const views = db
      .query("SELECT name FROM sqlite_master WHERE type='view'")
      .all()
      .map((r: any) => r.name)
    expect(views).toContain("bee_awareness")
    db.close()
  })
})

describe("SessionsRepo", () => {
  it("crea y recupera una sesión", () => {
    const db = makeTestDb()
    const repo = new SessionsRepo(db)
    repo.create({
      id: SESSION_ID,
      project_path: "/tmp/test",
      project_name: "test",
      started_at: NOW,
      mode: "plan",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      version: "0.2.0",
    })
    const s = repo.get(SESSION_ID)
    expect(s?.id).toBe(SESSION_ID)
    expect(s?.mode).toBe("plan")
    db.close()
  })

  it("acumula tokens y costo", () => {
    const db = makeTestDb()
    const repo = new SessionsRepo(db)
    repo.create({ id: SESSION_ID, project_path: "/", project_name: "p", started_at: NOW, mode: "plan", provider: "a", model: "m", version: "v" })
    repo.addTokens(SESSION_ID, 1000, 500, 0.05)
    const s = repo.get(SESSION_ID)
    expect(s?.token_count).toBe(1500)
    expect(s?.cost_usd).toBeCloseTo(0.05)
    db.close()
  })
})

describe("AgentContextRepo (Blackboard)", () => {
  function setup() {
    const db = makeTestDb()
    const sessions = new SessionsRepo(db)
    sessions.create({ id: SESSION_ID, project_path: "/", project_name: "p", started_at: NOW, mode: "plan", provider: "a", model: "m", version: "v" })
    return { db, repo: new AgentContextRepo(db) }
  }

  it("escribe y lee contexto activo", () => {
    const { db, repo } = setup()
    repo.write(SESSION_ID, "bee", "decision", "Usar SQLite para token blacklist")
    const entries = repo.readRelevant(SESSION_ID)
    expect(entries.length).toBe(1)
    expect(entries[0].content).toBe("Usar SQLite para token blacklist")
    db.close()
  })

  it("supersede marca el contexto como superseded", () => {
    const { db, repo } = setup()
    const id = repo.write(SESSION_ID, "bee", "decision", "Decisión vieja")
    repo.supersede(id, "bee")
    const entries = repo.readRelevant(SESSION_ID)
    expect(entries.length).toBe(0)
    db.close()
  })

  it("beeAwareness filtra por session_id (Fix Bug-C)", () => {
    const db = makeTestDb()
    const sessions = new SessionsRepo(db)
    sessions.create({ id: "s1", project_path: "/", project_name: "p", started_at: NOW, mode: "plan", provider: "a", model: "m", version: "v" })
    sessions.create({ id: "s2", project_path: "/", project_name: "p", started_at: NOW, mode: "plan", provider: "a", model: "m", version: "v" })
    const awareness = new AgentAwarenessRepo(db)
    awareness.upsert({ session_id: "s1", observer: "bee", observed: "backend", phase: "coding", status: "running", last_known_action: null, last_known_file: null, pending_question: null, confidence: 1.0 })
    awareness.upsert({ session_id: "s2", observer: "bee", observed: "frontend", phase: "coding", status: "waiting", last_known_action: null, last_known_file: null, pending_question: null, confidence: 1.0 })

    const repo = new AgentContextRepo(db)
    const s1Result = repo.beeAwareness("s1")
    const s2Result = repo.beeAwareness("s2")
    expect(s1Result.map(r => r.worker)).toContain("backend")
    expect(s1Result.map(r => r.worker)).not.toContain("frontend")
    expect(s2Result.map(r => r.worker)).toContain("frontend")
    db.close()
  })
})

describe("AgentConflictsRepo", () => {
  it("crea y lista conflictos no resueltos", () => {
    const db = makeTestDb()
    const sessions = new SessionsRepo(db)
    sessions.create({ id: SESSION_ID, project_path: "/", project_name: "p", started_at: NOW, mode: "plan", provider: "a", model: "m", version: "v" })
    const repo = new AgentConflictsRepo(db)
    repo.create({ sessionId: SESSION_ID, agentA: "backend", agentB: "frontend", type: "file_collision", description: "schema.ts", filePath: "src/db/schema.ts", severity: "high" })
    expect(repo.listUnresolved(SESSION_ID).length).toBe(1)
    db.close()
  })

  it("resolve marca conflicto como resuelto", () => {
    const db = makeTestDb()
    const sessions = new SessionsRepo(db)
    sessions.create({ id: SESSION_ID, project_path: "/", project_name: "p", started_at: NOW, mode: "plan", provider: "a", model: "m", version: "v" })
    const repo = new AgentConflictsRepo(db)
    const id = repo.create({ sessionId: SESSION_ID, agentA: "a", agentB: "b", type: "decision_clash", description: "clash", severity: "medium" })
    repo.resolve(id, "bee", "Se eligió la opción de backend")
    expect(repo.listUnresolved(SESSION_ID).length).toBe(0)
    db.close()
  })
})

describe("CheckpointsRepo", () => {
  it("crea checkpoint y lista archivos", () => {
    const db = makeTestDb()
    const sessions = new SessionsRepo(db)
    sessions.create({ id: SESSION_ID, project_path: "/", project_name: "p", started_at: NOW, mode: "plan", provider: "a", model: "m", version: "v" })
    const repo = new CheckpointsRepo(db)
    const cpId = `cp_${NOW}_abcd`
    repo.createCheckpoint({ id: cpId, session_id: SESSION_ID, created_by: "bee", description: "antes de JWT", file_count: 1, created_at: NOW })
    repo.addFile({ checkpoint_id: cpId, file_path: "src/auth.ts", content: Buffer.from("original"), content_hash: "abc123", operation: "modified" })
    const files = repo.getFiles(cpId)
    expect(files.length).toBe(1)
    expect(files[0].operation).toBe("modified")
    db.close()
  })
})

describe("AdrsRepo", () => {
  it("upsert y búsqueda FTS5", () => {
    const db = makeTestDb()
    const repo = new AdrsRepo(db)
    repo.upsert({ file_path: "adrs/ADR-003.md", title: "Database Schema", status: "accepted", content: "Usar migration script para cambios al schema", summary: null, updated_at: NOW })
    const results = repo.search("migration script")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].title).toBe("Database Schema")
    db.close()
  })
})

describe("FileRisksRepo", () => {
  it("upsert y lectura por sesión", () => {
    const db = makeTestDb()
    const sessions = new SessionsRepo(db)
    sessions.create({ id: SESSION_ID, project_path: "/", project_name: "p", started_at: NOW, mode: "plan", provider: "a", model: "m", version: "v" })
    const repo = new FileRisksRepo(db)
    repo.upsert({ session_id: SESSION_ID, file_path: "src/db/schema.ts", risk_level: "high", operation: "modified", adr_ref: "ADR-003", reason: "Cambio de schema sin migration", agent: "backend" })
    const risks = repo.listBySession(SESSION_ID)
    expect(risks.length).toBe(1)
    expect(risks[0].risk_level).toBe("high")
    db.close()
  })
})

afterAll(() => {
  // Tests usan :memory: — nada que limpiar
})
