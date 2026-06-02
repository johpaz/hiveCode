/**
 * Real API integration tests — PLAN mode
 *
 * Pipeline: BEE → ProductManager → Architecture → ADR saved to DB.
 * Write tools blocked. No engineering phases dispatched.
 *
 * Uses real LLM (opencode-go via Bun.secrets). No mocks.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { initSessionArray, setMode } from "@johpaz/hivecode-code/modes/session-array"
import {
  setupRealHiveHome,
  getLastTask,
  getTaskPhases,
  getTaskDecisions,
  getTaskNarrative,
  type RealTestSetup,
} from "./helpers/real-setup"

const ENGINEERING_PHASES = ["backend", "frontend", "mobile", "data_scientist", "devops", "dba", "integration", "test"]

let setup: RealTestSetup
let manager: CoordinatorManager

beforeAll(async () => {
  initSessionArray()
  setup = setupRealHiveHome()
  manager = new CoordinatorManager()
  await manager.startAll()
}, 30_000)

afterAll(async () => {
  try { await manager.stopAll() } catch { /* ignore reflector race on shutdown */ }
  await Bun.sleep(200)
  setup.cleanup()
})

describe("plan mode — real LLM", () => {
  test(
    "BEE → architecture: ADR guardado, sin fases de ingeniería, task completada",
    async () => {
      setMode("plan")
      await manager.runTask("Design a TypeScript function that reverses a string", "plan")

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()
      expect(task!.status).toBe("completed")
      expect(task!.mode).toBe("plan")
      expect(task!.duration_ms).toBeGreaterThan(0)

      const phases = getTaskPhases(setup.db, task!.id)
      const coords = phases.map(p => p.coordinator)
      expect(coords).toContain("bee")
      // Architecture debe estar en el pipeline (directa o via dispatch)
      expect(coords.some(c => ["architecture", "product_manager"].includes(c))).toBe(true)

      // Ninguna fase de ingeniería puede haberse ejecutado en plan mode
      for (const eng of ENGINEERING_PHASES) {
        expect(coords).not.toContain(eng)
      }

      const decisions = getTaskDecisions(setup.db, task!.id)
      expect(decisions.length).toBeGreaterThanOrEqual(1)
      expect(decisions[0].title).toBeTruthy()
      expect(decisions[0].decision).toBeTruthy()

      const narrative = getTaskNarrative(setup.db, task!.id)
      expect(narrative.some(n => n.coordinator === "bee")).toBe(true)
      // Al menos un coordinador de planificación debe tener narrativa
      expect(narrative.some(n => ["architecture", "product_manager"].includes(n.coordinator))).toBe(true)
    },
    90_000
  )
})
