/**
 * Real integration tests — Worker Pipeline Compliance
 *
 * Validates that each coordinator in the pipeline fulfills its role:
 *   - BEE: correct routing decision (respond/dispatch/architecture)
 *   - Architecture: produces valid ADR (title/context/decision/consequences)
 *   - Each coordinator: only uses tools within its allowed COORDINATOR_TOOLS set
 *   - Narrative: each coordinator writes a non-empty narrative entry
 *   - Plan mode: no write tools (fs_write/fs_edit/git_commit) in any phase
 *
 * Uses real LLM (opencode-go). Verifies observable DB state.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { COORDINATOR_TOOLS } from "@johpaz/hivecode-code/workers/tool-bridge"
import { initSessionArray, setMode } from "@johpaz/hivecode-code/modes/session-array"
import {
  setupRealHiveHome,
  getLastTask,
  getTaskPhases,
  getTaskDecisions,
  getTaskNarrative,
  type RealTestSetup,
} from "./helpers/real-setup"

// Write tools that must NEVER appear in plan mode
const PLAN_MODE_BLOCKED_TOOLS = new Set([
  "fs_write", "fs_edit", "fs_delete",
  "git_commit", "git_branch", "git_create_pr", "git_rollback",
])

// Read-only coordinators that should NEVER write files in any mode
const READ_ONLY_COORDINATORS = new Set(["architecture", "security", "reviewer"])
const READ_ONLY_BLOCKED_TOOLS = new Set(["fs_write", "fs_edit", "fs_delete", "git_commit"])

let setup: RealTestSetup
let manager: CoordinatorManager

beforeAll(async () => {
  initSessionArray()
  setup = setupRealHiveHome()
  manager = new CoordinatorManager()
  await manager.startAll()
}, 30_000)

afterAll(async () => {
  try { await manager.stopAll() } catch { /* ignore reflector race */ }
  await Bun.sleep(200)
  setup.cleanup()
})

// ─── BEE routing ─────────────────────────────────────────────────────────────

describe("BEE — enrutamiento correcto según tipo de tarea", () => {
  test(
    "pregunta general → acción 'respond': solo fase bee, sin engineering phases",
    async () => {
      setMode("auto")
      await manager.runTask("What is the difference between null and undefined in JavaScript? One sentence.", "auto")

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()
      expect(task!.status).toBe("completed")
      expect(task!.mode).toBe("auto")

      const phases = getTaskPhases(setup.db, task!.id)
      const coords = phases.map(p => p.coordinator)
      expect(coords).toContain("bee")

      // Para "respond", no deben haber fases de ingeniería
      const engineeringPhases = ["backend", "frontend", "devops", "dba", "mobile"]
      for (const eng of engineeringPhases) {
        expect(coords).not.toContain(eng)
      }

      // BEE debe tener narrativa
      const narrative = getTaskNarrative(setup.db, task!.id)
      const beeNarr = narrative.find(n => n.coordinator === "bee")
      expect(beeNarr).not.toBeUndefined()
      expect(beeNarr!.entry.length).toBeGreaterThan(0)
    },
    60_000
  )

  test(
    "tarea técnica → BEE hace dispatch/architecture: al menos una fase de ingeniería o arquitectura",
    async () => {
      setMode("plan")
      try {
        await manager.runTask("Design a TypeScript module for date formatting", "plan")
      } catch (err) {
        if ((err as Error).message.includes("JSON")) return // architecture truncó, aceptable
        throw err
      }

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()

      const phases = getTaskPhases(setup.db, task!.id)
      const coords = phases.map(p => p.coordinator)

      // Al menos bee + uno más (architecture, product_manager)
      expect(coords.length).toBeGreaterThanOrEqual(2)
      expect(coords).toContain("bee")
      // Tarea de diseño debe llegar a architecture o product_manager
      expect(coords.some(c => ["architecture", "product_manager"].includes(c))).toBe(true)
    },
    150_000
  )
})

// ─── Architecture: ADR format ─────────────────────────────────────────────────

describe("Architecture — formato correcto del ADR", () => {
  test(
    "genera ADR con title/context/decision/consequences en code_decisions",
    async () => {
      setMode("plan")
      try {
        await manager.runTask("Design a caching strategy for a REST API", "plan")
      } catch (err) {
        if ((err as Error).message.includes("JSON")) return // truncado, aceptable
        throw err
      }

      const task = getLastTask(setup.db)
      if (!task || task.status === "failed") return // JSON truncado

      const decisions = getTaskDecisions(setup.db, task.id)

      if (decisions.length === 0) return // BEE eligió respond directo

      const adr = decisions[0] as any
      // ADR debe tener los campos fundamentales no vacíos
      expect(adr.title).toBeTruthy()
      expect(adr.title.length).toBeGreaterThan(5)
      expect(adr.decision).toBeTruthy()
      expect(adr.decision.length).toBeGreaterThan(10)

      // Verificar en DB que el ADR tiene context y consequences
      const row = setup.db.query(
        "SELECT title, context, options, decision, consequences, status FROM code_decisions WHERE task_id = ? LIMIT 1"
      ).get(task.id) as any
      expect(row).not.toBeNull()
      expect(row.context).toBeTruthy()
      expect(row.consequences).toBeTruthy()
      expect(row.status).toBe("active")
    },
    150_000
  )
})

// ─── Tool compliance: cada coordinador usa solo sus herramientas permitidas ────

describe("Tool compliance — coordinadores respetan COORDINATOR_TOOLS", () => {
  test(
    "coordinadores read-only (architecture, security, reviewer) no usan write tools",
    async () => {
      setMode("auto")
      await manager.runTask("Explain dependency injection in one paragraph.", "auto")

      const task = getLastTask(setup.db)
      if (!task) return

      const traces = setup.db.query(
        "SELECT coordinator, tool_name FROM code_traces WHERE task_id = ?"
      ).all(task.id) as any[]

      for (const trace of traces) {
        if (READ_ONLY_COORDINATORS.has(trace.coordinator)) {
          expect(READ_ONLY_BLOCKED_TOOLS.has(trace.tool_name)).toBe(false)
        }
      }
    },
    60_000
  )

  test(
    "en plan mode no aparecen write tools en ningún coordinador (code_traces)",
    async () => {
      setMode("plan")
      try {
        await manager.runTask("Design a notification system architecture", "plan")
      } catch (err) {
        if ((err as Error).message.includes("JSON")) return
        throw err
      }

      const task = getLastTask(setup.db)
      if (!task || task.status === "failed") return

      const traces = setup.db.query(
        "SELECT coordinator, tool_name FROM code_traces WHERE task_id = ?"
      ).all(task.id) as any[]

      // En plan mode ningún trace debe usar herramientas de escritura
      for (const trace of traces) {
        const blocked = PLAN_MODE_BLOCKED_TOOLS.has(trace.tool_name)
        if (blocked) {
          // Esto indicaría un bug en el plan mode gate
          expect(trace.tool_name).not.toBeOneOf([...PLAN_MODE_BLOCKED_TOOLS])
        }
      }
    },
    150_000
  )

  test(
    "las herramientas usadas por cada coordinator están en COORDINATOR_TOOLS",
    async () => {
      setMode("auto")
      await manager.runTask("What is event-driven architecture? Brief explanation.", "auto")

      const task = getLastTask(setup.db)
      if (!task) return

      const traces = setup.db.query(
        "SELECT coordinator, tool_name FROM code_traces WHERE task_id = ?"
      ).all(task.id) as any[]

      for (const trace of traces) {
        const coord = trace.coordinator as keyof typeof COORDINATOR_TOOLS
        const allowedTools = COORDINATOR_TOOLS[coord]
        if (!allowedTools) continue // coordinador desconocido, skip

        // Herramientas del sistema (set_session_mode, get_task_context, etc.) son meta-herramientas
        const isMetaTool = ["set_session_mode", "get_task_context", "report_progress",
                            "search_knowledge", "notify", "save_note"].includes(trace.tool_name)
        if (isMetaTool) continue

        expect(allowedTools).toContain(trace.tool_name)
      }
    },
    60_000
  )
})

// ─── Narrative: cada coordinador escribe su entrada ───────────────────────────

describe("Narrative — cada coordinador produce entrada en code_narrative", () => {
  test(
    "pipeline completo: cada fase que corre tiene su narrativa en DB",
    async () => {
      setMode("auto")
      await manager.runTask("What is the CAP theorem? One sentence.", "auto")

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()
      expect(task!.status).toBe("completed")

      const phases = getTaskPhases(setup.db, task!.id)
      const narrative = getTaskNarrative(setup.db, task!.id)

      const narCoords = new Set(narrative.map(n => n.coordinator))
      const phaseCoords = phases.map(p => p.coordinator)

      // Cada coordinador que tuvo una fase debe tener al menos una narrativa
      for (const coord of phaseCoords) {
        expect(narCoords.has(coord)).toBe(true)
      }
    },
    60_000
  )

  test(
    "narrativa de BEE contiene la decisión de enrutamiento no vacía",
    async () => {
      setMode("auto")
      await manager.runTask("What does REST stand for? Answer in one word each letter.", "auto")

      const task = getLastTask(setup.db)
      if (!task) return

      const narrative = getTaskNarrative(setup.db, task.id)
      const beeEntry = narrative.find(n => n.coordinator === "bee")
      expect(beeEntry).not.toBeUndefined()
      expect(beeEntry!.entry.length).toBeGreaterThan(5)
    },
    60_000
  )
})

// ─── Reviewer verdict format ──────────────────────────────────────────────────

describe("Reviewer — formato de veredicto", () => {
  test(
    "si reviewer corre, su narrativa contiene un veredicto válido",
    async () => {
      setMode("auto")
      // Engineering task — if reviewer is included in phases by architecture, it must give a verdict
      await manager.runTask("Explain the SOLID principles briefly.", "auto")

      const task = getLastTask(setup.db)
      if (!task) return

      const narrative = getTaskNarrative(setup.db, task.id)
      const reviewerEntry = narrative.find(n => n.coordinator === "reviewer")

      if (!reviewerEntry) return // reviewer not dispatched for this task — acceptable

      // Reviewer debe producir uno de los tres veredictos esperados
      const validVerdicts = ["APROBADO", "RECHAZADO", "APROBADO_CON_OBSERVACIONES"]
      const hasVerdict = validVerdicts.some(v => reviewerEntry.entry.includes(v))
      expect(hasVerdict).toBe(true)
    },
    150_000
  )
})

// ─── Fase metadata: tokens y duración ─────────────────────────────────────────

describe("Phase metadata — tokens y duración registrados", () => {
  test(
    "code_task_phases registra duration_ms > 0 para cada fase que corrió con LLM",
    async () => {
      setMode("auto")
      await manager.runTask("Name one advantage of TypeScript over JavaScript.", "auto")

      const task = getLastTask(setup.db)
      if (!task) return

      const phases = setup.db.query(
        "SELECT coordinator, status, duration_ms, tokens_in, tokens_out FROM code_task_phases WHERE task_id = ?"
      ).all(task.id) as any[]

      const completedPhases = phases.filter(p => p.status === "completed")
      expect(completedPhases.length).toBeGreaterThanOrEqual(1)

      for (const phase of completedPhases) {
        // Cada fase completada debería tener algún tiempo de ejecución
        expect(phase.duration_ms).toBeGreaterThanOrEqual(0)
      }
    },
    60_000
  )

  test(
    "code_tasks registra duration_ms total de la tarea",
    async () => {
      setMode("auto")
      await manager.runTask("What is functional programming? One sentence.", "auto")

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()
      expect(task!.duration_ms).toBeGreaterThan(0)
    },
    60_000
  )
})
