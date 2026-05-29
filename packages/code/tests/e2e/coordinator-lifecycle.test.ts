import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { getTestDb, resetTestDb, cleanupTestDb } from "../helpers/setup-db"
import { CoordinatorManager } from "../../src/workers/coordinator-manager"
import { parsePlan, getDefaultPhases, groupPhasesByLevel } from "../../src/workers/plan-parser"
import type { CoordinatorResult, CoordinatorTask, PhaseName } from "../../src/workers/types"
import { initSessionArray, setMode } from "../../src/modes/session-array"

function makeArchResult(taskId: string): CoordinatorResult {
  return {
    taskId,
    phaseId: 1,
    coordinator: "architecture",
    status: "completed",
    narrativeEntry: JSON.stringify({
      phases: [
        { coordinator: "backend", description: "Implement API", confidence: 0.9 },
        { coordinator: "test", description: "Write tests", confidence: 0.85, dependsOn: ["backend"] },
      ],
      interfaces: ["API: GET /items", "DB: items table"],
      adr: {
        title: "REST API for items",
        context: "Need items CRUD",
        options: ["REST", "GraphQL"],
        decision: "REST",
        consequences: "Simpler, standard",
      },
      risks: [{ severity: "LOW", description: "Rate limiting needed" }],
    }),
    filesModified: [],
    durationMs: 3000,
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

function makeProductResult(task: CoordinatorTask): CoordinatorResult {
  return {
    taskId: task.taskId,
    phaseId: task.phaseId,
    coordinator: "product_manager",
    status: "completed",
    narrativeEntry: "PRD: Items CRUD. Acceptance criteria: create, list, update and delete items.",
    filesModified: [],
    durationMs: 500,
  }
}

function makePhaseResult(taskId: string, coordinator: string, phaseId: number): CoordinatorResult {
  return {
    taskId,
    phaseId,
    coordinator,
    status: "completed",
    narrativeEntry: `${coordinator} phase completed. All tasks done.`,
    filesModified: coordinator === "backend" ? ["src/api.ts", "src/db.ts"] : ["tests/api.test.ts"],
    durationMs: 5000,
  }
}

function setupManager(): { manager: CoordinatorManager; cleanup: () => void } {
  initSessionArray()
  const manager = new CoordinatorManager()
  spyOn(manager as any, "startAll").mockImplementation(() => Promise.resolve())
  spyOn(manager as any, "stopAll").mockImplementation(() => Promise.resolve())
  return { manager, cleanup: () => {} }
}

describe("e2e: CoordinatorManager.runTask — plan mode", () => {
  let db: ReturnType<typeof getTestDb>

  beforeAll(() => {
    resetTestDb()
    db = getTestDb()
  })

  afterAll(() => { cleanupTestDb() })

  test("plan mode: session → task → product manager → architecture → ADR → DB, no further phases", async () => {
    const { manager } = setupManager()
    setMode("plan")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) => {
        if (phase === "bee") return Promise.resolve(makeBeeArchitectureResult(task))
        if (phase === "product_manager") return Promise.resolve(makeProductResult(task))
        expect(phase).toBe("architecture")
        expect(task.mode).toBe("plan")
        expect(task.narrative).toContain("ProductManager PRD")
        return Promise.resolve(makeArchResult(task.taskId))
      }
    )

    await manager.runTask("Build a REST API for items", "plan")

    expect(dispatchSpy).toHaveBeenCalledTimes(3)
    expect(dispatchSpy.mock.calls.map((call: any[]) => call[0])).toEqual(["bee", "product_manager", "architecture"])

    const rows = db.query("SELECT * FROM code_tasks WHERE description = 'Build a REST API for items'").all() as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe("completed")

    const decisions = db.query("SELECT * FROM code_decisions WHERE title = 'REST API for items'").all() as any[]
    expect(decisions.length).toBe(1)
    expect(decisions[0].decision).toBe("REST")

    const narratives = db.query("SELECT * FROM code_narrative WHERE coordinator = 'architecture'").all() as any[]
    expect(narratives.length).toBe(1)
    const productNarratives = db.query("SELECT * FROM code_narrative WHERE coordinator = 'product_manager'").all() as any[]
    expect(productNarratives.length).toBe(1)

    dispatchSpy.mockRestore()
  })
})

describe("e2e: CoordinatorManager.runTask — auto mode with multiple phases", () => {
  let db: ReturnType<typeof getTestDb>

  beforeAll(() => {
    resetTestDb()
    db = getTestDb()
  })

  afterAll(() => { cleanupTestDb() })

  test("auto mode: architecture → backend → test → narrative + traces in DB", async () => {
    const { manager } = setupManager()
    setMode("auto")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) => {
        if (phase === "bee") return Promise.resolve(makeBeeArchitectureResult(task))
        if (phase === "product_manager") return Promise.resolve(makeProductResult(task))
        if (phase === "architecture") return Promise.resolve(makeArchResult(task.taskId))
        return Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
      }
    )

    await manager.runTask("Build a REST API for items", "auto")

    expect(dispatchSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
    const dispatchedPhases = dispatchSpy.mock.calls.map((c: any) => c[0])
    expect(dispatchedPhases).toContain("product_manager")
    expect(dispatchedPhases).toContain("architecture")
    expect(dispatchedPhases).toContain("backend")
    expect(dispatchedPhases).toContain("test")

    const tasks = db.query("SELECT * FROM code_tasks").all() as any[]
    expect(tasks.length).toBe(1)
    expect(tasks[0].status).toBe("completed")

    const decisions = db.query("SELECT * FROM code_decisions").all() as any[]
    expect(decisions.length).toBe(1)
    expect(decisions[0].title).toBe("REST API for items")

    const narratives = db.query("SELECT * FROM code_narrative ORDER BY id").all() as any[]
    expect(narratives.length).toBeGreaterThanOrEqual(2)

    const phases = db.query("SELECT * FROM code_task_phases ORDER BY id").all() as any[]
    const completedPhases = phases.filter(p => p.status === "completed")
    expect(completedPhases.length).toBeGreaterThanOrEqual(2)

    dispatchSpy.mockRestore()
  })
})

describe("e2e: CoordinatorManager.runTask — approval mode with checkpoint", () => {
  let db: ReturnType<typeof getTestDb>

  beforeAll(() => {
    resetTestDb()
    db = getTestDb()
  })

  afterAll(() => { cleanupTestDb() })

  test("approval mode: pauses after each level for user decision", async () => {
    const { manager } = setupManager()
    setMode("approval")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) => {
        if (phase === "bee") return Promise.resolve(makeBeeArchitectureResult(task))
        if (phase === "product_manager") return Promise.resolve(makeProductResult(task))
        if (phase === "architecture") return Promise.resolve(makeArchResult(task.taskId))
        return Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
      }
    )

    let approvalCalled = false

    await manager.runTask("Build a REST API for items", "approval", async (ctx) => {
      approvalCalled = true
      expect(ctx.phase).toBeDefined()
      return "approve"
    })

    expect(approvalCalled).toBe(true)

    const tasks = db.query("SELECT * FROM code_tasks").all() as any[]
    expect(tasks[0].status).toBe("completed")

    dispatchSpy.mockRestore()
  })

  test("approval mode: cancel at checkpoint stops execution", async () => {
    resetTestDb()
    db = getTestDb()

    const { manager } = setupManager()
    setMode("approval")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) => {
        if (phase === "bee") return Promise.resolve(makeBeeArchitectureResult(task))
        if (phase === "product_manager") return Promise.resolve(makeProductResult(task))
        if (phase === "architecture") return Promise.resolve(makeArchResult(task.taskId))
        return Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
      }
    )

    await manager.runTask("Build a REST API for items", "approval", async () => "cancel")

    const tasks = db.query("SELECT * FROM code_tasks").all() as any[]
    expect(tasks[0].status).toBe("cancelled")

    dispatchSpy.mockRestore()
  })
})

describe("e2e: CoordinatorManager.runTask — architecture failure", () => {
  let db: ReturnType<typeof getTestDb>

  beforeAll(() => {
    resetTestDb()
    db = getTestDb()
  })

  afterAll(() => { cleanupTestDb() })

  test("failed architecture phase marks task as failed", async () => {
    const { manager } = setupManager()
    setMode("auto")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) => {
        if (phase === "bee") return Promise.resolve(makeBeeArchitectureResult(task))
        if (phase === "product_manager") return Promise.resolve(makeProductResult(task))
        if (phase === "architecture") {
          return Promise.resolve({
            taskId: task.taskId,
            phaseId: task.phaseId,
            coordinator: "architecture",
            status: "failed",
            narrativeEntry: "Architecture failed: could not determine approach",
            filesModified: [],
            blockerDescription: "Ambiguous requirements",
            durationMs: 1000,
          } as CoordinatorResult)
        }
        return Promise.resolve({
          taskId: task.taskId,
          phaseId: 1,
          coordinator: "architecture",
          status: "failed",
          narrativeEntry: "Architecture failed: could not determine approach",
          filesModified: [],
          blockerDescription: "Ambiguous requirements",
          durationMs: 1000,
        } as CoordinatorResult)
      }
    )

    await expect(manager.runTask("Do something ambiguous", "auto")).rejects.toThrow("Ambiguous requirements")

    const tasks = db.query("SELECT * FROM code_tasks").all() as any[]
    expect(tasks.length).toBe(1)
    expect(tasks[0].status).toBe("failed")

    const decisions = db.query("SELECT * FROM code_decisions").all() as any[]
    expect(decisions.length).toBe(0)

    dispatchSpy.mockRestore()
  })
})

describe("e2e: full pipeline — session → task → phases → narrative → decisions → traces → snapshots", () => {
  let db: ReturnType<typeof getTestDb>

  beforeAll(() => {
    resetTestDb()
    db = getTestDb()
  })

  afterAll(() => { cleanupTestDb() })

  test("complete lifecycle produces correct DB state", async () => {
    const { manager } = setupManager()
    setMode("auto")

    const dispatchSpy = spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) => {
        if (phase === "bee") return Promise.resolve(makeBeeArchitectureResult(task))
        if (phase === "product_manager") return Promise.resolve(makeProductResult(task))
        if (phase === "architecture") return Promise.resolve(makeArchResult(task.taskId))
        return Promise.resolve(makePhaseResult(task.taskId, phase, task.phaseId))
      }
    )

    await manager.runTask("Build CRUD API", "auto")

    const sessions = db.query("SELECT * FROM code_sessions").all() as any[]
    expect(sessions.length).toBe(1)

    const tasks = db.query("SELECT * FROM code_tasks").all() as any[]
    expect(tasks.length).toBe(1)
    expect(tasks[0].status).toBe("completed")
    expect(tasks[0].mode).toBe("auto")

    const decisions = db.query("SELECT * FROM code_decisions").all() as any[]
    expect(decisions.length).toBe(1)
    expect(decisions[0].title).toBe("REST API for items")

    const narratives = db.query("SELECT * FROM code_narrative ORDER BY id").all() as any[]
    expect(narratives.length).toBeGreaterThanOrEqual(2)
    const coordinators = narratives.map(n => n.coordinator)
    expect(coordinators).toContain("product_manager")
    expect(coordinators).toContain("architecture")
    expect(coordinators).toContain("backend")

    const phases = db.query("SELECT * FROM code_task_phases ORDER BY id").all() as any[]
    expect(phases.length).toBeGreaterThanOrEqual(2)
    expect(phases.every(p => p.status === "completed")).toBe(true)

    dispatchSpy.mockRestore()
  })
})
