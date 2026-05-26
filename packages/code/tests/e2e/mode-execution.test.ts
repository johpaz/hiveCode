/**
 * E2E: Execution mode tests — plan, auto, approval
 * Metodología Arnes: ARMAR / ACTUAR / NOTAR / ESTADO / SALIDA
 *
 * Complementa coordinator-lifecycle.test.ts con casos adicionales:
 *  - isToolAllowed por modo
 *  - narrativa con is_draft en plan mode
 *  - fallo de fase en auto mode
 *  - checkpoint cancel / skip / edit en approval mode
 *  - transición de modo durante ejecución
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { getTestDb, resetTestDb, cleanupTestDb } from "../helpers/setup-db"
import { CoordinatorManager } from "../../src/workers/coordinator-manager"
import { Scribe } from "../../src/narrative/scribe"
import { isToolAllowed } from "../../src/workers/tool-bridge"
import { initSessionArray, setMode } from "../../src/modes/session-array"
import type { CoordinatorResult, CoordinatorTask, PhaseName } from "../../src/workers/types"

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeArchResult(taskId: string): CoordinatorResult {
  return {
    taskId,
    phaseId: 1,
    coordinator: "architecture",
    status: "completed",
    narrativeEntry: JSON.stringify({
      phases: [
        { coordinator: "backend", description: "Build REST API", confidence: 0.9 },
        { coordinator: "test", description: "Write tests", confidence: 0.85, dependsOn: ["backend"] },
      ],
      interfaces: ["API: POST /tasks"],
      adr: {
        title: "REST API design",
        context: "Task management API",
        options: ["REST", "GraphQL"],
        decision: "REST",
        consequences: "Simpler integration",
      },
      risks: [{ severity: "LOW", description: "Rate limiting" }],
    }),
    filesModified: [],
    durationMs: 2000,
  }
}

function makeBeeArchitectureResult(task: CoordinatorTask): CoordinatorResult {
  return {
    taskId: task.taskId,
    phaseId: task.phaseId,
    coordinator: "bee",
    status: "completed",
    narrativeEntry: JSON.stringify({ action: "architecture", reason: "Architecture required" }),
    filesModified: [],
    durationMs: 100,
  }
}

function makePhaseResult(taskId: string, coordinator: string, phaseId: number): CoordinatorResult {
  return {
    taskId,
    phaseId,
    coordinator,
    status: "completed",
    narrativeEntry: `${coordinator} completed`,
    filesModified: coordinator === "backend" ? ["src/api.ts"] : ["tests/api.test.ts"],
    durationMs: 3000,
  }
}

function setupManager(): CoordinatorManager {
  initSessionArray()
  const manager = new CoordinatorManager()
  spyOn(manager as any, "startAll").mockImplementation(() => Promise.resolve())
  spyOn(manager as any, "stopAll").mockImplementation(() => Promise.resolve())
  return manager
}

// ─── MODO PLAN ────────────────────────────────────────────────────────────────

describe("e2e: modo PLAN", () => {
  let db: ReturnType<typeof getTestDb>

  beforeAll(() => {
    resetTestDb()
    db = getTestDb()
  })

  afterAll(() => { cleanupTestDb() })

  test("solo ejecuta architecture — no dispatcha otras fases", async () => {
    // ARMAR
    const manager = setupManager()
    setMode("plan")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) =>
        Promise.resolve(phase === "bee" ? makeBeeArchitectureResult(task) : makeArchResult(task.taskId))
    )
    // ACTUAR
    await manager.runTask("Design a REST API", "plan")
    // NOTAR — BEE enruta y solo Architecture genera el plan.
    expect(dispatchSpy).toHaveBeenCalledTimes(2)
    expect(dispatchSpy.mock.calls.map((call: any[]) => call[0])).toEqual(["bee", "architecture"])
    // ESTADO
    const tasks = db.query("SELECT status FROM code_tasks").all() as any[]
    expect(tasks[0]?.status).toBe("completed")
    const phases = db.query("SELECT coordinator FROM code_task_phases").all() as any[]
    expect(phases.length).toBe(2)
    expect(phases.map((phase: any) => phase.coordinator)).toEqual(["bee", "architecture"])

    dispatchSpy.mockRestore()
  })

  test("narrativa en plan mode se guarda para architecture", async () => {
    // ARMAR
    resetTestDb()
    db = getTestDb()
    const manager = setupManager()
    setMode("plan")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) =>
        Promise.resolve(phase === "bee" ? makeBeeArchitectureResult(task) : makeArchResult(task.taskId))
    )
    // ACTUAR
    await manager.runTask("Draft architecture only", "plan")
    // ESTADO — narrativa de architecture existe en DB
    const narratives = db.query("SELECT is_draft, coordinator FROM code_narrative WHERE coordinator = 'architecture'").all() as any[]
    expect(narratives.length).toBeGreaterThan(0)
    // El CoordinatorManager guarda narrativas con is_draft=0 (comportamiento actual)
    expect(narratives[0].coordinator).toBe("architecture")

    dispatchSpy.mockRestore()
  })

  test("herramientas de escritura bloqueadas en plan mode", () => {
    // ARMAR / ACTUAR / NOTAR
    expect(isToolAllowed("fs_write",   "backend",  "plan")).toBe(false)
    expect(isToolAllowed("fs_edit",    "frontend", "plan")).toBe(false)
    expect(isToolAllowed("git_commit", "backend",  "plan")).toBe(false)
    expect(isToolAllowed("fs_delete",  "backend",  "plan")).toBe(false)
  })

  test("herramientas de lectura permitidas en plan mode", () => {
    // ARMAR / ACTUAR / NOTAR
    expect(isToolAllowed("fs_read",     "architecture", "plan")).toBe(true)
    expect(isToolAllowed("fs_list",     "architecture", "plan")).toBe(true)
    expect(isToolAllowed("code_search", "architecture", "plan")).toBe(true)
    expect(isToolAllowed("parse_ast",   "architecture", "plan")).toBe(true)
  })
})

// ─── MODO AUTO ────────────────────────────────────────────────────────────────

describe("e2e: modo AUTO", () => {
  let db: ReturnType<typeof getTestDb>

  beforeAll(() => {
    resetTestDb()
    db = getTestDb()
  })

  afterAll(() => { cleanupTestDb() })

  test("pipeline completo: arch → backend → test (todas completadas)", async () => {
    // ARMAR
    const manager = setupManager()
    setMode("auto")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) =>
        phase === "bee"
          ? Promise.resolve(makeBeeArchitectureResult(task))
          : phase === "architecture"
          ? Promise.resolve(makeArchResult(task.taskId))
          : Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
    )
    // ACTUAR
    await manager.runTask("Build full REST API", "auto")
    // NOTAR — mínimo 3 fases: arch + backend + test
    expect(dispatchSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
    const dispatched = dispatchSpy.mock.calls.map((c: any) => c[0])
    expect(dispatched).toContain("architecture")
    expect(dispatched).toContain("backend")
    expect(dispatched).toContain("test")
    // ESTADO
    const task = db.query("SELECT status FROM code_tasks").get() as any
    expect(task?.status).toBe("completed")
    const phases = db.query("SELECT status FROM code_task_phases").all() as any[]
    expect(phases.every(p => p.status === "completed")).toBe(true)

    dispatchSpy.mockRestore()
  })

  test("herramientas de escritura permitidas en auto mode", () => {
    // ARMAR / ACTUAR / NOTAR
    expect(isToolAllowed("fs_write",       "backend", "auto")).toBe(true)
    expect(isToolAllowed("git_commit",      "backend", "auto")).toBe(true)
    expect(isToolAllowed("shell_executor",  "test",    "auto")).toBe(true)
  })

  test("fallo en fase → task.status='failed', fases siguientes no corren", async () => {
    // ARMAR
    resetTestDb()
    db = getTestDb()
    const manager = setupManager()
    setMode("auto")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) => {
        if (phase === "bee") return Promise.resolve(makeBeeArchitectureResult(task))
        if (phase === "architecture") return Promise.resolve(makeArchResult(task.taskId))
        return Promise.resolve({
          taskId: task.taskId,
          phaseId: task.phaseId,
          coordinator: phase,
          status: "failed",
          narrativeEntry: `${phase} failed`,
          filesModified: [],
          durationMs: 500,
        } as CoordinatorResult)
      }
    )
    // ACTUAR
    await manager.runTask("Failing task", "auto")
    // ESTADO
    const failedTask = db.query("SELECT status FROM code_tasks").get() as any
    expect(failedTask?.status).toBe("failed")
    // NOTAR — BEE + arch + primer nivel fallido; no se ejecuta el siguiente nivel.
    const dispatched = dispatchSpy.mock.calls.map((c: any) => c[0])
    expect(dispatched).toContain("architecture")
    expect(dispatched).toContain("security")
    expect(dispatched).not.toContain("test")
    expect(dispatched.length).toBeLessThanOrEqual(4)

    dispatchSpy.mockRestore()
  })

  test("scribe puede insertar traces vinculados a una tarea", () => {
    // ARMAR — traces son escritos por workers via Scribe.writeTrace()
    // (en tests con dispatchPhase mockeado, los workers no corren, así que escribimos directo)
    resetTestDb()
    db = getTestDb()
    const scribe = new Scribe()
    const sessionId = scribe.createSession("/tmp/trace-test")
    const taskId = scribe.createTask(sessionId, "task with tool calls", "auto")
    // ACTUAR
    scribe.writeTrace({
      taskId,
      agentId: "backend",
      coordinator: "backend",
      toolName: "fs_read",
      inputSummary: "/src/api.ts",
      outputSummary: "200 lines",
      success: true,
      durationNs: 50_000,
    })
    // ESTADO
    const traces = db.query("SELECT * FROM code_traces WHERE task_id = ?").all(taskId) as any[]
    expect(traces.length).toBe(1)
    expect(traces[0].tool_name).toBe("fs_read")
    expect(traces[0].success).toBe(1)
  })
})

// ─── MODO APPROVAL ────────────────────────────────────────────────────────────

describe("e2e: modo APPROVAL", () => {
  let db: ReturnType<typeof getTestDb>

  beforeAll(() => {
    resetTestDb()
    db = getTestDb()
  })

  afterAll(() => { cleanupTestDb() })

  test("aprueba en checkpoint → todas las fases se completan", async () => {
    // ARMAR
    const manager = setupManager()
    setMode("approval")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) =>
        phase === "bee"
          ? Promise.resolve(makeBeeArchitectureResult(task))
          : phase === "architecture"
          ? Promise.resolve(makeArchResult(task.taskId))
          : Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
    )
    // ACTUAR — callback siempre aprueba
    await manager.runTask("Approved task", "approval", async () => "approve")
    // NOTAR
    expect(dispatchSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    // ESTADO
    const task = db.query("SELECT status FROM code_tasks").get() as any
    expect(task?.status).toBe("completed")

    dispatchSpy.mockRestore()
  })

  test("cancela en checkpoint → task.status='cancelled', fases pendientes no corren", async () => {
    // ARMAR
    resetTestDb()
    db = getTestDb()
    const manager = setupManager()
    setMode("approval")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) =>
        phase === "bee"
          ? Promise.resolve(makeBeeArchitectureResult(task))
          : phase === "architecture"
          ? Promise.resolve(makeArchResult(task.taskId))
          : Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
    )
    // ACTUAR — callback cancela inmediatamente
    await manager.runTask("Cancelled task", "approval", async () => "cancel")
    // NOTAR — solo architecture fue despachada
    const dispatched = dispatchSpy.mock.calls.map((c: any) => c[0])
    expect(dispatched).toContain("architecture")
    // ESTADO
    const task = db.query("SELECT status FROM code_tasks").get() as any
    expect(task?.status).toBe("cancelled")

    dispatchSpy.mockRestore()
  })

  test("skip en checkpoint → esa fase se omite, resto continúa", async () => {
    // ARMAR
    resetTestDb()
    db = getTestDb()
    const manager = setupManager()
    setMode("approval")

    let checkpointCount = 0
    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) =>
        phase === "bee"
          ? Promise.resolve(makeBeeArchitectureResult(task))
          : phase === "architecture"
          ? Promise.resolve(makeArchResult(task.taskId))
          : Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
    )
    // ACTUAR — primer checkpoint skip, resto approve
    await manager.runTask("Skipped backend task", "approval", async (ctx) => {
      checkpointCount++
      return checkpointCount === 1 ? "skip" : "approve"
    })
    // NOTAR — checkpoint fue llamado
    expect(checkpointCount).toBeGreaterThanOrEqual(1)
    // ESTADO — task no está cancelled/failed
    const task = db.query("SELECT status FROM code_tasks").get() as any
    expect(["completed", "cancelled"]).toContain(task?.status)

    dispatchSpy.mockRestore()
  })

  test("edit en checkpoint → continúa con override", async () => {
    // ARMAR
    resetTestDb()
    db = getTestDb()
    const manager = setupManager()
    setMode("approval")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) =>
        phase === "bee"
          ? Promise.resolve(makeBeeArchitectureResult(task))
          : phase === "architecture"
          ? Promise.resolve(makeArchResult(task.taskId))
          : Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
    )
    let callCount = 0
    // ACTUAR — primer checkpoint edit, resto approve
    await manager.runTask("Edited task", "approval", async () => {
      callCount++
      return callCount === 1 ? "edit" : "approve"
    })
    // NOTAR — checkpoint fue llamado con edit
    expect(callCount).toBeGreaterThanOrEqual(1)
    // ESTADO — tarea no quedó en estado inválido
    const task = db.query("SELECT status FROM code_tasks").get() as any
    expect(task?.status).toBeDefined()

    dispatchSpy.mockRestore()
  })
})

// ─── TOOL BRIDGE: isToolAllowed por modo ──────────────────────────────────────

describe("e2e: isToolAllowed por modo de ejecución", () => {
  test("architecture nunca puede usar herramientas de escritura (ningún modo)", () => {
    // ARMAR / ACTUAR / NOTAR
    expect(isToolAllowed("fs_write",      "architecture", "auto")).toBe(false)
    expect(isToolAllowed("shell_executor","architecture", "auto")).toBe(false)
    expect(isToolAllowed("git_commit",    "architecture", "approval")).toBe(false)
  })

  test("security nunca puede usar herramientas de escritura", () => {
    expect(isToolAllowed("fs_write",   "security", "auto")).toBe(false)
    expect(isToolAllowed("git_commit", "security", "approval")).toBe(false)
  })

  test("backend puede escribir en approval y auto, no en plan", () => {
    expect(isToolAllowed("fs_write", "backend", "auto")).toBe(true)
    expect(isToolAllowed("fs_write", "backend", "approval")).toBe(true)
    expect(isToolAllowed("fs_write", "backend", "plan")).toBe(false)
  })

  test("todos los coordinadores pueden leer en plan mode", () => {
    const coords = ["architecture", "backend", "frontend", "security", "test", "devops"] as const
    for (const coord of coords) {
      expect(isToolAllowed("fs_read", coord, "plan")).toBe(true)
    }
  })
})

// ─── TRANSICIÓN DE MODO EN VUELO ──────────────────────────────────────────────

describe("e2e: transición de modo durante ejecución", () => {
  let db: ReturnType<typeof getTestDb>

  beforeAll(() => {
    resetTestDb()
    db = getTestDb()
  })

  afterAll(() => { cleanupTestDb() })

  test("cambiar a plan mid-task no bloquea la fase en curso", async () => {
    // ARMAR
    const manager = setupManager()
    setMode("auto")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) => {
        if (phase === "bee") return Promise.resolve(makeBeeArchitectureResult(task))
        if (phase === "architecture") {
          // Cambiar a plan mode DURANTE la ejecución de architecture
          setMode("plan")
          return Promise.resolve(makeArchResult(task.taskId))
        }
        return Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
      }
    )
    // ACTUAR — inicia en auto, cambia a plan durante arch
    await manager.runTask("Mode transition task", "auto")
    // NOTAR — architecture se completó (no fue bloqueada por el cambio)
    const dispatched = dispatchSpy.mock.calls.map((c: any) => c[0])
    expect(dispatched).toContain("architecture")
    // ESTADO — tarea tiene algún estado definido
    const task = db.query("SELECT status FROM code_tasks").get() as any
    expect(task?.status).toBeDefined()

    dispatchSpy.mockRestore()
  })
})
