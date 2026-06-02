/**
 * Real API integration tests — AUTO mode
 *
 * Targets BEE's "respond" action (acción directa sin fases de ingeniería),
 * usando una pregunta factual simple que no requiere trabajo técnico.
 *
 * Si BEE elige "architecture" el test aún pasa — la aserción primaria es
 * task.status = "completed".
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
  getTaskNarrative,
  type RealTestSetup,
} from "./helpers/real-setup"

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

describe("auto mode — real LLM", () => {
  test(
    "pregunta factual: BEE responde directo (respond action), task completada",
    async () => {
      setMode("auto")
      // Pregunta factual de una palabra — diseñada para forzar acción "respond" en BEE
      await manager.runTask(
        "What programming language is TypeScript based on? Reply in exactly one word.",
        "auto"
      )

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()
      expect(task!.status).toBe("completed")
      expect(task!.mode).toBe("auto")
      expect(task!.duration_ms).toBeGreaterThan(0)

      // BEE narrative siempre existe
      const narrative = getTaskNarrative(setup.db, task!.id)
      expect(narrative.some(n => n.coordinator === "bee")).toBe(true)

      // Para una respuesta directa (respond), no deben haber fases de ingeniería
      const phases = getTaskPhases(setup.db, task!.id)
      const coords = phases.map(p => p.coordinator)
      for (const eng of ["backend", "frontend", "test", "devops", "dba"]) {
        expect(coords).not.toContain(eng)
      }
    },
    60_000
  )

  test(
    "segunda tarea en auto mode: pipeline completo si BEE decide architecture",
    async () => {
      setMode("auto")
      // Esta tarea puede ir por la ruta architecture/dispatch — verificamos que complete
      await manager.runTask("Explain what a TypeScript interface is in one sentence.", "auto")

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()
      expect(task!.status).toBe("completed")
      expect(task!.mode).toBe("auto")

      // Sin importar la ruta de BEE, la tarea debe completarse con narrativa
      const narrative = getTaskNarrative(setup.db, task!.id)
      expect(narrative.length).toBeGreaterThanOrEqual(1)
    },
    90_000
  )
})
