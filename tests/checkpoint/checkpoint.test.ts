import { describe, it, expect, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { SESSION_SCHEMA } from "@johpaz/hivecode-core/db/schema"
import { SessionsRepo } from "@johpaz/hivecode-core/db/repos/sessions"
import { CheckpointManager } from "@johpaz/hivecode-code/checkpoint/manager"
import type { IpcEmitter } from "@johpaz/hivecode-code/context/ipc-emitter"

const SID = "test-cp-session"
const NOW = Date.now()

// Directorio temporal para archivos de prueba
const TMP = path.join(os.tmpdir(), `hivecode-cp-test-${process.pid}`)

function makeDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.transaction(() => { for (const s of SESSION_SCHEMA) db.run(s) })()
  new SessionsRepo(db).create({
    id: SID, project_path: TMP, project_name: "test",
    started_at: NOW, mode: "plan",
    provider: "anthropic", model: "claude-sonnet", version: "0.2.0",
  })
  return db
}

function makeEmitter(): { emitter: IpcEmitter; events: { event: string; payload: unknown }[] } {
  const events: { event: string; payload: unknown }[] = []
  return { emitter: { emit: (e, p) => events.push({ event: e, payload: p }) }, events }
}

function tmpFile(name: string): string {
  return path.join(TMP, name)
}

afterEach(() => {
  // Limpiar archivos temporales tras cada test
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
})

describe("CheckpointManager — create", () => {
  it("genera un ID con prefijo cp_", async () => {
    mkdirSync(TMP, { recursive: true })
    const db = makeDb()
    const { emitter } = makeEmitter()
    const mgr = new CheckpointManager(db, SID, emitter)
    const id = await mgr.create("test checkpoint", [], [])
    expect(id).toMatch(/^cp_\d+_[a-f0-9]{4}$/)
    db.close()
  })

  it("emite checkpoint_created por IPC", async () => {
    mkdirSync(TMP, { recursive: true })
    const db = makeDb()
    const { emitter, events } = makeEmitter()
    const mgr = new CheckpointManager(db, SID, emitter)
    await mgr.create("emit test", [], [])
    expect(events.some(e => e.event === "checkpoint_created")).toBe(true)
    db.close()
  })

  it("hace snapshot de archivos existentes (modified)", async () => {
    mkdirSync(TMP, { recursive: true })
    const file = tmpFile("auth.ts")
    writeFileSync(file, "export const token = 'original'")

    const db = makeDb()
    const { emitter } = makeEmitter()
    const mgr = new CheckpointManager(db, SID, emitter)
    const id = await mgr.create("antes de JWT", [file], [])

    const cps = mgr.list()
    expect(cps.length).toBe(1)
    expect(cps[0].file_count).toBe(1)
    db.close()
  })

  it("registra archivos a crear (created) — Bug-E fix", async () => {
    mkdirSync(TMP, { recursive: true })
    const newFile = tmpFile("new-feature.ts")
    // El archivo aún NO existe — el agente lo va a crear

    const db = makeDb()
    const { emitter } = makeEmitter()
    const mgr = new CheckpointManager(db, SID, emitter)
    // filePaths vacío, filesToCreate con el archivo nuevo
    const id = await mgr.create("antes de crear feature", [], [newFile])

    const cps = mgr.list()
    expect(cps[0].file_count).toBe(1)
    db.close()
  })

  it("no duplica si el contenido no cambió", async () => {
    mkdirSync(TMP, { recursive: true })
    const file = tmpFile("stable.ts")
    writeFileSync(file, "// sin cambios")

    const db = makeDb()
    const { emitter } = makeEmitter()
    const mgr = new CheckpointManager(db, SID, emitter)

    // Primer checkpoint
    await mgr.create("cp1", [file], [])
    // Segundo checkpoint con el mismo archivo sin cambiar
    await mgr.create("cp2", [file], [])

    const cps = mgr.list()
    // cps[0] = cp2 (más reciente, ORDER BY created_at DESC, rowid DESC)
    const cp2 = cps.find(c => c.description === "cp2")
    expect(cp2?.file_count).toBe(0)
    db.close()
  })
})

describe("CheckpointManager — rollback", () => {
  it("restaura un archivo modificado al contenido previo", async () => {
    mkdirSync(TMP, { recursive: true })
    const file = tmpFile("middleware.ts")
    const original = "export const original = true"
    writeFileSync(file, original)

    const db = makeDb()
    const { emitter, events } = makeEmitter()
    const mgr = new CheckpointManager(db, SID, emitter)

    // Snapshot antes de modificar
    const cpId = await mgr.create("before edit", [file], [])

    // Simular modificación del agente
    writeFileSync(file, "export const modified = true")
    expect(readFileSync(file, "utf8")).toBe("export const modified = true")

    // Rollback
    await mgr.rollback(cpId)
    expect(readFileSync(file, "utf8")).toBe(original)
    expect(events.some(e => e.event === "rollback_complete")).toBe(true)
    db.close()
  })

  it("elimina un archivo creado por el agente al hacer rollback", async () => {
    mkdirSync(TMP, { recursive: true })
    const newFile = tmpFile("agent-created.ts")

    const db = makeDb()
    const { emitter } = makeEmitter()
    const mgr = new CheckpointManager(db, SID, emitter)

    // Snapshot: el agente va a crear este archivo
    const cpId = await mgr.create("before create", [], [newFile])

    // Simular que el agente crea el archivo
    writeFileSync(newFile, "export const created = true")
    expect(existsSync(newFile)).toBe(true)

    // Rollback — debe eliminar el archivo
    await mgr.rollback(cpId)
    expect(existsSync(newFile)).toBe(false)
    db.close()
  })

  it("emite rollback_complete con files_restored correcto", async () => {
    mkdirSync(TMP, { recursive: true })
    const f1 = tmpFile("a.ts")
    const f2 = tmpFile("b.ts")
    writeFileSync(f1, "a")
    writeFileSync(f2, "b")

    const db = makeDb()
    const { emitter, events } = makeEmitter()
    const mgr = new CheckpointManager(db, SID, emitter)

    const cpId = await mgr.create("multi-file", [f1, f2], [])
    writeFileSync(f1, "a-modified")
    writeFileSync(f2, "b-modified")

    await mgr.rollback(cpId)

    const rollbackEvent = events.find(e => e.event === "rollback_complete") as any
    expect(rollbackEvent?.payload?.files_restored).toBe(2)
    db.close()
  })

  it("rollback de HALT captura todos los archivos", async () => {
    mkdirSync(TMP, { recursive: true })
    const file = tmpFile("important.ts")
    writeFileSync(file, "export const safe = true")

    const db = makeDb()
    const { emitter } = makeEmitter()
    const mgr = new CheckpointManager(db, SID, emitter)

    const haltId = await mgr.halt([file])
    expect(haltId).toMatch(/^cp_/)

    const cps = mgr.list()
    expect(cps[0].created_by).toBe("halt")
    db.close()
  })
})
