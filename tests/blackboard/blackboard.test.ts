import { describe, it, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { SESSION_SCHEMA } from "@johpaz/hivecode-core/db/schema"
import { SessionsRepo } from "@johpaz/hivecode-core/db/repos/sessions"
import { Blackboard } from "@johpaz/hivecode-code/context/blackboard"
import { ConflictDetector } from "@johpaz/hivecode-code/context/conflict-detector"
import type { IpcEmitter } from "@johpaz/hivecode-code/context/ipc-emitter"

const SID = "test-bb-session"
const NOW = Date.now()

function makeDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.transaction(() => { for (const s of SESSION_SCHEMA) db.run(s) })()
  new SessionsRepo(db).create({
    id: SID, project_path: "/", project_name: "test",
    started_at: NOW, mode: "plan",
    provider: "anthropic", model: "claude-sonnet", version: "0.2.0",
  })
  return db
}

function makeEmitter(): { emitter: IpcEmitter; events: { event: string; payload: unknown }[] } {
  const events: { event: string; payload: unknown }[] = []
  return { emitter: { emit: (e, p) => events.push({ event: e, payload: p }) }, events }
}

describe("Blackboard", () => {
  it("escribe y lee contexto activo", () => {
    const db = makeDb()
    const bb = new Blackboard(db, SID)
    bb.write("bee", "decision", "Usar SQLite para token blacklist")
    const entries = bb.readRelevant("bee")
    expect(entries.length).toBe(1)
    expect(entries[0].content).toBe("Usar SQLite para token blacklist")
    db.close()
  })

  it("emite context_update por IPC al escribir", async () => {
    const db = makeDb()
    const { emitter, events } = makeEmitter()
    const bb = new Blackboard(db, SID, emitter)
    await bb.write("backend", "decision", "JWT middleware listo")
    expect(events.some(e => e.event === "context_update")).toBe(true)
    db.close()
  })

  it("supersede deja el entry inactivo", async () => {
    const db = makeDb()
    const bb = new Blackboard(db, SID)
    const id = await bb.write("bee", "decision", "Decisión vieja")
    bb.supersede(id, "bee")
    const entries = bb.readRelevant("bee")
    expect(entries.length).toBe(0)
    db.close()
  })

  it("beeAwareness devuelve workers observados", async () => {
    const db = makeDb()
    const bb = new Blackboard(db, SID)
    bb.updateWorkerStatus("backend", "running", "coding")
    bb.updateWorkerStatus("frontend", "waiting")
    const awareness = bb.beeAwareness()
    const workers = awareness.map(a => a.worker)
    expect(workers).toContain("backend")
    expect(workers).toContain("frontend")
    db.close()
  })

  it("getConstraints devuelve constraints activos para un archivo", async () => {
    const db = makeDb()
    const bb = new Blackboard(db, SID)
    await bb.write("bee", "constraint", "No modificar sin migration script", {
      filePath: "src/db/schema.ts",
    })
    const constraints = bb.getConstraints("src/db/schema.ts")
    expect(constraints.length).toBe(1)
    expect(constraints[0].content).toContain("migration")
    db.close()
  })
})

describe("ConflictDetector", () => {
  it("detecta file_collision cuando dos workers tocan el mismo archivo", async () => {
    const db = makeDb()
    const { emitter, events } = makeEmitter()
    const bb = new Blackboard(db, SID, emitter)
    const detector = new ConflictDetector(db, SID, bb, emitter)

    // Backend ya registró riesgo en schema.ts
    const { FileRisksRepo } = await import("@johpaz/hivecode-core/db/repos/file-risks")
    new FileRisksRepo(db).upsert({
      session_id: SID,
      file_path: "src/db/schema.ts",
      risk_level: "medium",
      operation: "modified",
      adr_ref: null,
      reason: null,
      agent: "backend",
    })

    // Frontend intenta tocar el mismo archivo → colisión
    const conflicts = await detector.checkBeforeWrite("frontend", "src/db/schema.ts")
    expect(conflicts.some(c => c.type === "file_collision")).toBe(true)
    expect(events.some(e => e.event === "conflict_detected")).toBe(true)
    db.close()
  })

  it("detecta adr_violation cuando hay constraint activo", async () => {
    const db = makeDb()
    const { emitter } = makeEmitter()
    const bb = new Blackboard(db, SID, emitter)
    const detector = new ConflictDetector(db, SID, bb, emitter)

    await bb.write("bee", "constraint", "Requiere migration script", {
      filePath: "src/db/schema.ts",
    })

    const conflicts = await detector.checkBeforeWrite("backend", "src/db/schema.ts")
    expect(conflicts.some(c => c.type === "adr_violation")).toBe(true)
    expect(conflicts.some(c => c.severity === "critical")).toBe(true)
    db.close()
  })

  it("resolve marca el conflicto como resuelto y emite evento", async () => {
    const db = makeDb()
    const { emitter, events } = makeEmitter()
    const bb = new Blackboard(db, SID, emitter)
    const detector = new ConflictDetector(db, SID, bb, emitter)

    const { FileRisksRepo } = await import("@johpaz/hivecode-core/db/repos/file-risks")
    new FileRisksRepo(db).upsert({
      session_id: SID, file_path: "src/auth.ts",
      risk_level: "high", operation: "modified",
      adr_ref: null, reason: null, agent: "backend",
    })
    await detector.checkBeforeWrite("frontend", "src/auth.ts")

    const unresolved = detector.listUnresolved()
    expect(unresolved.length).toBeGreaterThan(0)

    detector.resolve(unresolved[0].id, "bee", "Backend termina primero")
    expect(detector.listUnresolved().length).toBe(0)
    expect(events.some(e => e.event === "conflict_resolved")).toBe(true)
    db.close()
  })
})
