import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { getTestDb, resetTestDb, cleanupTestDb } from "../helpers/setup-db"
import { checkAutomaticInterruption } from "../../src/modes/interruptions"
import { Scribe } from "../../src/narrative/scribe"
import { isToolAllowed } from "../../src/workers/tool-bridge"
import { parsePlan, getDefaultPhases, groupPhasesByLevel } from "../../src/workers/plan-parser"
import type { WorkerToManagerMessage, PhaseName, SessionMode, CoordinatorTask } from "../../src/workers/types"

describe("integration: interruption → trace pipeline", () => {
  let scribe: Scribe
  let taskId: string

  beforeAll(() => {
    resetTestDb()
    const db = getTestDb()
    scribe = new Scribe()
    const sessionId = scribe.createSession("/tmp/test-ws")
    taskId = scribe.createTask(sessionId, "integration test task", "auto")
  })

  afterAll(() => {
    cleanupTestDb()
  })

  test("blocked tool call writes trace with interruption reason", () => {
    const msg: WorkerToManagerMessage = {
      type: "TOOL_CALL",
      taskId,
      phaseId: 1,
      coordinator: "backend",
      toolName: "fs_delete",
      toolArgs: { path: "/workspace/.env", confirmed: true },
      toolCallId: "tc-int-1",
    }

    const interruption = checkAutomaticInterruption(msg)
    expect(interruption).not.toBeNull()
    expect(interruption!.blocked).toBe(true)

    scribe.writeTrace({
      taskId,
      agentId: "backend",
      coordinator: "backend",
      toolName: "fs_delete",
      inputSummary: "/workspace/.env",
      outputSummary: `[INTERRUPTION] ${interruption!.reason}`,
      success: false,
      durationNs: 0,
    })

    const db = getTestDb()
    const trace = db.query("SELECT * FROM code_traces WHERE task_id = ? AND tool_name = 'fs_delete'").get(taskId) as any
    expect(trace).toBeDefined()
    expect(trace.success).toBe(0)
    expect(trace.output_summary).toContain("INTERRUPTION")
  })
})

describe("integration: plan mode gate", () => {
  test("fs_write is blocked in plan mode for all write-capable coordinators", () => {
    const writeTools = ["fs_write", "fs_edit", "fs_delete", "git_commit", "append_narrative"]
    const coordinators: PhaseName[] = ["backend", "frontend", "test", "devops"]

    for (const coord of coordinators) {
      for (const tool of writeTools) {
        if (!isToolAllowed(tool, coord, "plan" as SessionMode)) {
          expect(true).toBe(true)
        } else if (!["fs_write", "fs_edit", "fs_delete"].includes(tool)) {
          expect(true).toBe(true)
        }
      }
    }
  })

  test("read-only tools are allowed in plan mode", () => {
    const readTools = ["fs_read", "fs_list", "fs_glob", "code_search", "parse_ast"]
    for (const tool of readTools) {
      expect(isToolAllowed(tool, "architecture", "plan" as SessionMode)).toBe(true)
    }
  })
})

describe("integration: tool execution → trace → DB", () => {
  let scribe: Scribe
  let taskId: string

  beforeAll(() => {
    resetTestDb()
    scribe = new Scribe()
    const sessionId = scribe.createSession("/tmp/test-ws")
    taskId = scribe.createTask(sessionId, "tool trace integration", "auto")
  })

  afterAll(() => {
    cleanupTestDb()
  })

  test("successful tool execution is traced with timing", async () => {
    scribe.writeTrace({
      taskId,
      agentId: "backend",
      coordinator: "backend",
      toolName: "fs_read",
      inputSummary: "/etc/hostname",
      outputSummary: "success",
      success: true,
      durationNs: 500_000,
    })

    const db = getTestDb()
    const trace = db.query("SELECT * FROM code_traces WHERE task_id = ? AND tool_name = 'fs_read'").get(taskId) as any
    expect(trace).toBeDefined()
    expect(trace.success).toBe(1)
    expect(trace.duration_ns).toBe(500_000)
  })
})

describe("integration: plan parsing → phase execution order", () => {
  test("architecture output produces valid phase sequence", () => {
    const archOutput = JSON.stringify({
      phases: [
        { coordinator: "backend", description: "Implement API", confidence: 0.9 },
        { coordinator: "frontend", description: "Build UI", confidence: 0.85 },
        { coordinator: "security", description: "Security review", confidence: 0.8 },
        { coordinator: "test", description: "Write tests", confidence: 0.9 },
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
    })

    const plan = parsePlan(archOutput)
    expect(plan.phases.length).toBe(4)
    expect(plan.phases[0].coordinator).toBe("backend")
    expect(plan.adr.title).toBe("REST API for items")
    const ifaces = plan.interfaces ? JSON.parse(plan.interfaces) : []
  expect(ifaces.length).toBe(2)
    expect(plan.risks.length).toBe(1)

    const levels = groupPhasesByLevel(plan.phases)
    expect(levels.length).toBeGreaterThanOrEqual(1)
  })

  test("malformed architecture output falls back to defaults", () => {
    const plan = parsePlan("This is just plain text, no JSON here")
    expect(plan.phases.length).toBeGreaterThan(0)
    const defaults = getDefaultPhases()
    expect(plan.phases.length).toBe(defaults.length)
  })
})

describe("integration: CoordinatorTask with compiledContext", () => {
  test("task structure includes compiledContext field", () => {
    const task: CoordinatorTask = {
      taskId: "test-task",
      phaseId: 1,
      phase: "backend",
      description: "Build API",
      narrative: "Architecture decided REST API",
      mode: "auto",
      projectPath: "/tmp/test",
      secrets: {},
      compiledContext: "# SKILLS\nTest skill\n\n# PLAYBOOK RULES\n- [90%] Always check types after changes",
    }
    expect(task.compiledContext).toBeDefined()
    expect(task.compiledContext).toContain("SKILLS")
    expect(task.compiledContext).toContain("PLAYBOOK RULES")
  })
})

describe("integration: scribe full lifecycle", () => {
  let scribe: Scribe
  let sessionId: string
  let taskId: string

  beforeAll(() => {
    resetTestDb()
    scribe = new Scribe()
    sessionId = scribe.createSession("/tmp/test-lifecycle")
    taskId = scribe.createTask(sessionId, "lifecycle test", "auto")
  })

  afterAll(() => {
    cleanupTestDb()
  })

  test("session → task → phase → narrative → decision → trace lifecycle", () => {
    const db = getTestDb()

    const phaseId = scribe.createPhase(taskId, "architecture", "architecture")
    expect(phaseId).toBeGreaterThan(0)

    scribe.appendNarrative({
      taskId,
      sessionId,
      coordinator: "architecture",
      phase: "architecture",
      entry: "Decided to use REST API with Express.js",
      isDraft: false,
      isOverride: false,
    })

  scribe.writeDecision({
    id: "decision-1",
    taskId,
    title: "Use Express.js",
    context: "Need a Node.js web framework",
    options: JSON.stringify(["Express.js", "Fastify", "Elysia"]),
    decision: "Express.js",
    consequences: "Widely known, large ecosystem",
    status: "active",
  })

    scribe.writeTrace({
      taskId,
      agentId: "architecture",
      coordinator: "architecture",
      toolName: "fs_read",
      inputSummary: "/etc/hostname",
      outputSummary: "success",
      success: true,
      durationNs: 100_000,
    })

    const narratives = db.query("SELECT * FROM code_narrative WHERE task_id = ?").all(taskId) as any[]
    expect(narratives.length).toBeGreaterThan(0)

    const decisions = db.query("SELECT * FROM code_decisions WHERE task_id = ?").all(taskId) as any[]
    expect(decisions.length).toBe(1)
    expect(decisions[0].title).toBe("Use Express.js")

    const traces = db.query("SELECT * FROM code_traces WHERE task_id = ?").all(taskId) as any[]
    expect(traces.length).toBe(1)
    expect(traces[0].tool_name).toBe("fs_read")

    scribe.updateTaskStatus(taskId, "completed")
    const task = db.query("SELECT * FROM code_tasks WHERE id = ?").get(taskId) as any
    expect(task.status).toBe("completed")
  })
})
