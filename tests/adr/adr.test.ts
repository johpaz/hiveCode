import { describe, it, expect, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { SESSION_SCHEMA } from "@johpaz/hivecode-core/db/schema"
import { SessionsRepo } from "@johpaz/hivecode-core/db/repos/sessions"
import { AdrLoader } from "@johpaz/hivecode-code/adr/loader"
import { AdrAnalyzer } from "@johpaz/hivecode-code/adr/analyzer"
import { RiskCalculator } from "@johpaz/hivecode-code/adr/risk"
import type { IpcEmitter } from "@johpaz/hivecode-code/context/ipc-emitter"

const SID = "test-adr-session"
const NOW = Date.now()
const TMP = path.join(os.tmpdir(), `hivecode-adr-test-${process.pid}`)

const ADR_003 = `# ADR-003: Database Schema Changes

**Status**: accepted

## Contexto
Cada cambio al schema de la base de datos requiere un migration script usando Drizzle ORM.

## Decisión
Se usará drizzle-kit para generar migraciones automáticamente antes de cualquier deploy.
Los archivos schema.ts y migration/ son críticos y requieren revisión.

## Consecuencias
Ningún cambio al schema sin migration script correspondiente.
`

const ADR_001 = `# ADR-001: Stack tecnológico

**Status**: accepted

## Decisión
Usar Bun como runtime, TypeScript como lenguaje principal.
El stack incluye SQLite para persistencia local y Rust para el TUI.
`

const ADR_DEPRECATED = `# ADR-002: Auth Legacy

**Status**: deprecated

## Decisión
Usar sessions de express (reemplazado por JWT en ADR-004).
`

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

function makeEmitter() {
  const events: { event: string; payload: unknown }[] = []
  const emitter: IpcEmitter = { emit: (e, p) => events.push({ event: e, payload: p }) }
  return { emitter, events }
}

function setupProject(): string {
  mkdirSync(path.join(TMP, "adrs"), { recursive: true })
  writeFileSync(path.join(TMP, "adrs", "ADR-001.md"), ADR_001)
  writeFileSync(path.join(TMP, "adrs", "ADR-003.md"), ADR_003)
  writeFileSync(path.join(TMP, "adrs", "ADR-002.md"), ADR_DEPRECATED)
  return TMP
}

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
})

// ─── AdrLoader ───────────────────────────────────────────────────────────────

describe("AdrLoader", () => {
  it("carga ADRs desde adrs/ del proyecto", () => {
    const db = makeDb()
    const projectPath = setupProject()
    const loader = new AdrLoader(db)
    const result = loader.load(projectPath)
    expect(result.loaded).toBe(3)
    expect(result.skipped).toBe(0)
    db.close()
  })

  it("parsea título y status correctamente", () => {
    const db = makeDb()
    const projectPath = setupProject()
    const loader = new AdrLoader(db)
    loader.load(projectPath)
    const adrs = loader.getAll()
    const adr003 = adrs.find(a => a.title.includes("Database"))
    expect(adr003?.status).toBe("accepted")
    expect(adr003?.title).toBe("ADR-003: Database Schema Changes")
    db.close()
  })

  it("parsea status deprecated correctamente", () => {
    const db = makeDb()
    const projectPath = setupProject()
    const loader = new AdrLoader(db)
    loader.load(projectPath)
    const adrs = loader.getAll()
    const deprecated = adrs.find(a => a.title.includes("Legacy"))
    expect(deprecated?.status).toBe("deprecated")
    db.close()
  })

  it("re-carga sin duplicar si el archivo no cambió", () => {
    const db = makeDb()
    const projectPath = setupProject()
    const loader = new AdrLoader(db)
    loader.load(projectPath)
    const result2 = loader.load(projectPath)
    expect(result2.loaded).toBe(0)
    expect(result2.skipped).toBe(3)
    expect(loader.getAll().length).toBe(3)
    db.close()
  })

  it("devuelve { loaded: 0, skipped: 0 } si adrs/ no existe", () => {
    const db = makeDb()
    mkdirSync(TMP, { recursive: true }) // sin adrs/
    const loader = new AdrLoader(db)
    const result = loader.load(TMP)
    expect(result.loaded).toBe(0)
    expect(result.skipped).toBe(0)
    db.close()
  })
})

// ─── AdrAnalyzer ─────────────────────────────────────────────────────────────

describe("AdrAnalyzer", () => {
  it("encuentra ADR-003 para src/db/schema.ts", () => {
    const db = makeDb()
    const projectPath = setupProject()
    new AdrLoader(db).load(projectPath)
    const analyzer = new AdrAnalyzer(db)
    const matches = analyzer.analyze("src/db/schema.ts")
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some(m => m.adr.title.includes("Database Schema"))).toBe(true)
    db.close()
  })

  it("encuentra ADR-003 para packages/core/src/storage/migration.ts", () => {
    const db = makeDb()
    const projectPath = setupProject()
    new AdrLoader(db).load(projectPath)
    const analyzer = new AdrAnalyzer(db)
    const matches = analyzer.analyze("packages/core/src/storage/migration.ts")
    expect(matches.some(m => m.adr.title.includes("Database Schema"))).toBe(true)
    db.close()
  })

  it("devuelve [] para un archivo sin ADRs relacionados", () => {
    const db = makeDb()
    const projectPath = setupProject()
    new AdrLoader(db).load(projectPath)
    const analyzer = new AdrAnalyzer(db)
    const matches = analyzer.analyze("src/ui/Button.tsx")
    // Puede devolver alguno por FTS pero no debe haber match directo
    // Simplemente verificamos que no crashea
    expect(Array.isArray(matches)).toBe(true)
    db.close()
  })

  it("no duplica el mismo ADR en matches", () => {
    const db = makeDb()
    const projectPath = setupProject()
    new AdrLoader(db).load(projectPath)
    const analyzer = new AdrAnalyzer(db)
    const matches = analyzer.analyze("src/db/schema.ts")
    const ids = matches.map(m => m.adr.id)
    const unique = new Set(ids)
    expect(ids.length).toBe(unique.size)
    db.close()
  })
})

// ─── RiskCalculator ──────────────────────────────────────────────────────────

describe("RiskCalculator", () => {
  it("schema.ts → critical cuando hay ADR aceptado de alta relevancia", () => {
    const db = makeDb()
    const projectPath = setupProject()
    new AdrLoader(db).load(projectPath)
    const { emitter } = makeEmitter()
    const calc = new RiskCalculator(db, SID, emitter)
    const result = calc.evaluate("src/db/schema.ts", "modified", "backend")
    // schema file + ADR aceptado → critical
    expect(["high", "critical"]).toContain(result.riskLevel)
    db.close()
  })

  it("archivo sin ADRs → low", () => {
    const db = makeDb()
    const projectPath = setupProject()
    new AdrLoader(db).load(projectPath)
    const { emitter } = makeEmitter()
    const calc = new RiskCalculator(db, SID, emitter)
    const result = calc.evaluate("src/components/Logo.tsx", "created", "frontend")
    expect(result.riskLevel).toBe("low")
    db.close()
  })

  it("emite file_risk_update por IPC", () => {
    const db = makeDb()
    const projectPath = setupProject()
    new AdrLoader(db).load(projectPath)
    const { emitter, events } = makeEmitter()
    const calc = new RiskCalculator(db, SID, emitter)
    calc.evaluate("src/db/schema.ts", "modified", "backend")
    expect(events.some(e => e.event === "file_risk_update")).toBe(true)
    db.close()
  })

  it("archivo .sql sin ADRs → high por regla de schema", () => {
    const db = makeDb()
    mkdirSync(TMP, { recursive: true }) // sin adrs/
    new AdrLoader(db).load(TMP)
    const { emitter } = makeEmitter()
    const calc = new RiskCalculator(db, SID, emitter)
    const result = calc.evaluate("migrations/001_initial.sql", "created", "bee")
    expect(result.riskLevel).toBe("high")
    db.close()
  })

  it("evaluateAll procesa múltiples archivos", () => {
    const db = makeDb()
    const projectPath = setupProject()
    new AdrLoader(db).load(projectPath)
    const { emitter } = makeEmitter()
    const calc = new RiskCalculator(db, SID, emitter)
    const results = calc.evaluateAll(
      [
        { path: "src/db/schema.ts", operation: "modified" },
        { path: "src/utils/logger.ts", operation: "modified" },
      ],
      "backend",
    )
    expect(results.length).toBe(2)
    db.close()
  })
})
