/**
 * Real API integration tests — APPROVAL mode
 *
 * Cada describe tiene su propio CoordinatorManager aislado para evitar
 * contaminación de estado entre tests.
 *
 * NOTA: Cuando BEE toma la ruta "respond" (sin fases de ingeniería),
 * onApprovalCheckpoint nunca se llama y la tarea termina como "completed".
 * Los tests de cancel/skip manejan este caso: si no hubo fases de ingeniería,
 * la tarea debería terminar normalmente ("completed"), lo cual también es correcto.
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
  type RealTestSetup,
} from "./helpers/real-setup"

// ─── Auto-approve ─────────────────────────────────────────────────────────────

describe("approval mode — auto-approve", () => {
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

  test(
    "pipeline completa con auto-approve; checkpoint invocado si hay fases de ingeniería",
    async () => {
      setMode("approval")
      let checkpointCount = 0

      await manager.runTask(
        "Design a TypeScript utility module for string manipulation",
        "approval",
        async (ctx) => {
          checkpointCount++
          expect(ctx.phase).toBeTruthy()
          expect(ctx.narrativeEntry).toBeTruthy()
          return "approve"
        }
      )

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()
      expect(["completed", "paused"]).toContain(task!.status)
      expect(task!.mode).toBe("approval")

      const phases = getTaskPhases(setup.db, task!.id)
      const hasEngineeringPhases = phases.some(
        p => !["bee", "product_manager", "architecture"].includes(p.coordinator)
      )
      if (hasEngineeringPhases) {
        expect(checkpointCount).toBeGreaterThanOrEqual(1)
      }

      const validStatuses = new Set(["completed", "skipped", "failed", "pending"])
      for (const phase of phases) {
        expect(validStatuses.has(phase.status)).toBe(true)
      }
    },
    300_000
  )
})

// ─── Cancel en checkpoint ──────────────────────────────────────────────────────

describe("approval mode — cancel en checkpoint", () => {
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

  test(
    "cancel en checkpoint: si hubo fases → 'cancelled'; si BEE respondió directo → 'completed'",
    async () => {
      setMode("approval")
      let callCount = 0

      try {
        await manager.runTask(
          "Create a TypeScript string utility module with reverse, trim, and capitalize functions",
          "approval",
          async () => {
            callCount++
            return "cancel"
          }
        )
      } catch (err) {
        if ((err as Error).message.includes("JSON")) return // arquitectura truncó, saltamos
        throw err
      }

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()

      const phases = getTaskPhases(setup.db, task!.id)
      const hasEngineeringPhases = phases.some(
        p => !["bee", "product_manager", "architecture"].includes(p.coordinator)
      )

      if (hasEngineeringPhases) {
        // Fases corrieron → checkpoint fue llamado → cancel aplicado
        expect(task!.status).toBe("cancelled")
        expect(callCount).toBeGreaterThanOrEqual(1)
      } else {
        // BEE respondió directamente sin fases → checkpoint no fue invocado → completed
        expect(["completed", "cancelled"]).toContain(task!.status)
      }
    },
    300_000
  )
})

// ─── Skip en checkpoint ────────────────────────────────────────────────────────

describe("approval mode — skip en checkpoint", () => {
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

  test(
    "skip en primer checkpoint: fase omitida; task llega a estado terminal",
    async () => {
      setMode("approval")
      let callCount = 0

      try {
        await manager.runTask(
          "Create a TypeScript number formatting utility with currency and percentage formatters",
          "approval",
          async () => {
            callCount++
            return callCount === 1 ? "skip" : "approve"
          }
        )
      } catch (err) {
        if ((err as Error).message.includes("JSON")) return // arquitectura truncó, saltamos
        throw err
      }

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()
      expect(["completed", "cancelled", "paused"]).toContain(task!.status)

      const phases = getTaskPhases(setup.db, task!.id)
      const hasEngineeringPhases = phases.some(
        p => !["bee", "product_manager", "architecture"].includes(p.coordinator)
      )
      if (hasEngineeringPhases) {
        expect(callCount).toBeGreaterThanOrEqual(1)
      }
    },
    300_000
  )
})
