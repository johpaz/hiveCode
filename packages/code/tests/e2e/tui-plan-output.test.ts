import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CoordinatorManager } from "../../src/workers/coordinator-manager"
import type { CoordinatorResult, CoordinatorTask, PhaseName } from "../../src/workers/types"
import { initSessionArray, setMode } from "../../src/modes/session-array"
import { cleanupTestDb, resetTestDb } from "../helpers/setup-db"

const originalHiveHome = process.env.HIVE_HOME
const originalLogConsole = process.env.HIVE_LOG_CONSOLE
let hiveHome = ""

function beeArchitectureResult(task: CoordinatorTask): CoordinatorResult {
  return {
    taskId: task.taskId,
    phaseId: task.phaseId,
    coordinator: "bee",
    status: "completed",
    narrativeEntry: JSON.stringify({ action: "architecture", reason: "Needs an approvable plan" }),
    filesModified: [],
    durationMs: 1,
  }
}

function architecturePlanResult(task: CoordinatorTask): CoordinatorResult {
  return {
    taskId: task.taskId,
    phaseId: task.phaseId,
    coordinator: "architecture",
    status: "completed",
    narrativeEntry: JSON.stringify({
      phases: [
        { coordinator: "frontend", description: "Constrain PLAN rendering", confidence: 1 },
      ],
      adr: {
        title: "Contain PLAN output",
        context: "RAW_PLAN_CONTEXT_SENTINEL",
        options: ["IPC", "stdout"],
        decision: "Use IPC only in TUI sessions",
        consequences: "No terminal overwrite",
      },
      risks: [{ severity: "HIGH", description: "Raw stdout bypasses clipping" }],
    }),
    filesModified: [],
    durationMs: 1,
  }
}

beforeAll(() => {
  hiveHome = mkdtempSync(join(tmpdir(), "hivecode-tui-plan-"))
  process.env.HIVE_HOME = hiveHome
  process.env.HIVE_LOG_CONSOLE = "false"
  resetTestDb()
})

afterAll(() => {
  cleanupTestDb()
  if (originalHiveHome === undefined) delete process.env.HIVE_HOME
  else process.env.HIVE_HOME = originalHiveHome
  if (originalLogConsole === undefined) delete process.env.HIVE_LOG_CONSOLE
  else process.env.HIVE_LOG_CONSOLE = originalLogConsole
  rmSync(hiveHome, { recursive: true, force: true })
})

describe("TUI plan output boundary", () => {
  test("live narrative callback carries active task routing metadata", () => {
    const manager = new CoordinatorManager()
    const chunks: Array<Record<string, unknown>> = []
    manager.setNarrativeCallback((chunk) => chunks.push(chunk))

    ;(manager as any).activeTaskId = "task-route-1"
    ;(manager as any).activeSessionId = "session-route-1"
    ;(manager as any).handleWorkerMessage("backend", {
      type: "THINKING",
      content: "leyendo archivos relevantes",
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0].taskId).toBe("task-route-1")
    expect(chunks[0].sessionId).toBe("session-route-1")
    expect(chunks[0].coordinator).toBe("backend")
  })

  test("structured plan is delivered through IPC/callback without raw stdout", async () => {
    initSessionArray()
    setMode("plan")
    const manager = new CoordinatorManager()
    spyOn(manager as any, "startAll").mockImplementation(() => Promise.resolve())
    spyOn(manager as any, "stopAll").mockImplementation(() => Promise.resolve())
    spyOn(manager as any, "dispatchPhase").mockImplementation(
      (phase: PhaseName, task: CoordinatorTask) =>
        Promise.resolve(phase === "bee" ? beeArchitectureResult(task) : architecturePlanResult(task)),
    )

    const ipcEvents: Array<{ event: string; payload: unknown }> = []
    let finalResponse = ""
    manager.setIpcCallback((event, payload) => ipcEvents.push({ event, payload }))
    manager.setTaskCompleteCallback((response) => { finalResponse = response })

    const writes: string[] = []
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)

    try {
      await manager.runTask("Review PLAN layout", "plan")
    } finally {
      stdoutSpy.mockRestore()
    }

    expect(ipcEvents.some(({ event }) => event === "plan_update")).toBe(true)
    expect(finalResponse).toContain("RAW_PLAN_CONTEXT_SENTINEL")
    expect(writes.join("")).not.toContain("RAW_PLAN_CONTEXT_SENTINEL")
  })
})
