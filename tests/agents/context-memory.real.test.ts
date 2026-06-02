/**
 * Real integration tests — Context Compilation & Narrative Memory
 *
 * Tests the two persistence layers that feed the agent pipeline:
 *   1. Scribe: session/task/phase lifecycle, narrative FTS, traces, failure patterns
 *   2. compiledContext: playbook injection into worker system prompts
 *
 * No LLM calls — all DB operations, runs in seconds.
 * Uses setupRealHiveHome() to get the full schema without workers.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Scribe } from "@johpaz/hivecode-code/narrative/scribe"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { initSessionArray } from "@johpaz/hivecode-code/modes/session-array"
import {
  setupRealHiveHome,
  type RealTestSetup,
} from "./helpers/real-setup"

let setup: RealTestSetup
let scribe: Scribe

beforeAll(() => {
  initSessionArray()
  setup = setupRealHiveHome()
  scribe = new Scribe()
})

afterAll(() => {
  setup.cleanup()
})

// ─── Scribe: session / task / phase lifecycle ─────────────────────────────────

describe("Scribe — ciclo sesión → tarea → fase → narrativa", () => {
  test("createSession persiste en code_sessions", () => {
    const sessionId = scribe.createSession("/tmp/test-project")
    expect(sessionId).toBeTruthy()

    const row = setup.db.query("SELECT id, project_path, status FROM code_sessions WHERE id = ?")
      .get(sessionId) as any
    expect(row).not.toBeNull()
    expect(row.project_path).toBe("/tmp/test-project")
    expect(row.status).toBe("active")
  })

  test("createTask persiste en code_tasks con modo correcto", () => {
    const sessionId = scribe.createSession("/tmp/task-project")
    const taskId = scribe.createTask(sessionId, "Build a REST API", "auto")

    const row = setup.db.query("SELECT description, status, mode FROM code_tasks WHERE id = ?")
      .get(taskId) as any
    expect(row).not.toBeNull()
    expect(row.description).toBe("Build a REST API")
    expect(row.mode).toBe("auto")
    expect(row.status).toBe("pending")
  })

  test("createPhase + updatePhaseStatus persisten en code_task_phases", () => {
    const sessionId = scribe.createSession("/tmp/phase-project")
    const taskId = scribe.createTask(sessionId, "Phase test task", "plan")
    const phaseId = scribe.createPhase(taskId, "architecture", "architecture")
    expect(phaseId).toBeGreaterThan(0)

    scribe.updatePhaseStatus(phaseId, "completed", "Architecture completed successfully")

    const row = setup.db.query("SELECT status, result_summary FROM code_task_phases WHERE id = ?")
      .get(phaseId) as any
    expect(row.status).toBe("completed")
    expect(row.result_summary).toContain("completed")
  })

  test("appendNarrative escribe en code_narrative y es legible", () => {
    const sessionId = scribe.createSession("/tmp/narrative-project")
    const taskId = scribe.createTask(sessionId, "Narrative test task", "auto")

    const id = scribe.appendNarrative({
      taskId,
      sessionId,
      coordinator: "backend",
      phase: "implementation",
      entry: "Implemented the REST endpoints using Bun.serve",
      isDraft: false,
      isOverride: false,
    })
    expect(id).toBeGreaterThan(0)

    const rows = setup.db.query("SELECT coordinator, entry FROM code_narrative WHERE task_id = ?")
      .all(taskId) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].coordinator).toBe("backend")
    expect(rows[0].entry).toContain("REST")
  })

  test("readNarrative retorna entradas de una tarea", () => {
    const sessionId = scribe.createSession("/tmp/read-narrative-project")
    const taskId = scribe.createTask(sessionId, "Read narrative test", "auto")

    scribe.appendNarrative({ taskId, sessionId, coordinator: "bee", entry: "BEE dispatched to backend", isDraft: false, isOverride: false })
    scribe.appendNarrative({ taskId, sessionId, coordinator: "backend", entry: "Backend implemented API", isDraft: false, isOverride: false })

    const entries = scribe.readNarrative(taskId)
    expect(entries.length).toBeGreaterThanOrEqual(2)
    const coordinators = entries.map(e => e.coordinator)
    expect(coordinators).toContain("bee")
    expect(coordinators).toContain("backend")
  })

  test("getRecentTurns retorna turnos de conversación en orden cronológico", () => {
    const sessionId = scribe.createSession("/tmp/turns-project")
    const turnId1 = scribe.createTurn(sessionId, "First user message")
    scribe.completeTurn(turnId1, "First agent response")
    const turnId2 = scribe.createTurn(sessionId, "Second user message")
    scribe.completeTurn(turnId2, "Second agent response")

    const turns = scribe.getRecentTurns(sessionId, 10)
    expect(turns.length).toBeGreaterThanOrEqual(2)
    // getRecentTurns ordena DESC+reverse; ambos mensajes deben estar presentes
    const messages = turns.map(t => t.userMessage)
    expect(messages).toContain("First user message")
    expect(messages).toContain("Second user message")
  })
})

// ─── Scribe: traces (tool execution log) ─────────────────────────────────────

describe("Scribe — trazas de herramientas", () => {
  test("writeTrace persiste llamadas de herramientas por coordinador", () => {
    const sessionId = scribe.createSession("/tmp/trace-project")
    const taskId = scribe.createTask(sessionId, "Trace test task", "auto")

    scribe.writeTrace({
      taskId,
      agentId: "backend",
      coordinator: "backend",
      toolName: "fs_read",
      inputSummary: "/src/api.ts",
      outputSummary: "200 lines of TypeScript",
      success: true,
      durationNs: 45_000_000,
    })
    scribe.writeTrace({
      taskId,
      agentId: "backend",
      coordinator: "backend",
      toolName: "fs_write",
      inputSummary: "/src/new-endpoint.ts",
      outputSummary: "created",
      success: true,
      durationNs: 12_000_000,
    })

    const traces = setup.db.query(
      "SELECT tool_name, success FROM code_traces WHERE task_id = ? ORDER BY id"
    ).all(taskId) as any[]
    expect(traces.length).toBe(2)
    expect(traces[0].tool_name).toBe("fs_read")
    expect(traces[1].tool_name).toBe("fs_write")
    expect(traces.every(t => t.success === 1)).toBe(true)
  })

  test("writeTrace con success=false registra fallos", () => {
    const sessionId = scribe.createSession("/tmp/fail-trace-project")
    const taskId = scribe.createTask(sessionId, "Fail trace task", "auto")

    scribe.writeTrace({
      taskId,
      agentId: "test",
      coordinator: "test",
      toolName: "code_test",
      inputSummary: "bun test",
      outputSummary: "3 tests failed",
      success: false,
      durationNs: 5_000_000_000,
    })

    const row = setup.db.query(
      "SELECT success, tool_name FROM code_traces WHERE task_id = ?"
    ).get(taskId) as any
    expect(row.success).toBe(0)
    expect(row.tool_name).toBe("code_test")
  })

  test("múltiples coordinadores quedan separados en code_traces", () => {
    const sessionId = scribe.createSession("/tmp/multi-coord-trace")
    const taskId = scribe.createTask(sessionId, "Multi coordinator trace", "auto")

    const coordinators = ["bee", "backend", "test", "reviewer"]
    for (const coord of coordinators) {
      scribe.writeTrace({
        taskId,
        agentId: coord,
        coordinator: coord,
        toolName: "fs_read",
        outputSummary: `${coord} read a file`,
        success: true,
        durationNs: 1_000_000,
      })
    }

    const rows = setup.db.query(
      "SELECT DISTINCT coordinator FROM code_traces WHERE task_id = ? ORDER BY coordinator"
    ).all(taskId) as any[]
    const found = rows.map((r: any) => r.coordinator)
    expect(found).toContain("bee")
    expect(found).toContain("backend")
    expect(found).toContain("test")
    expect(found).toContain("reviewer")
  })
})

// ─── Scribe: failure patterns & learning harness ─────────────────────────────

describe("Scribe — patrones de fallo (learning harness)", () => {
  test("writeFailure persiste fallos tipados por coordinador", () => {
    const sessionId = scribe.createSession("/tmp/failure-project")
    const taskId = scribe.createTask(sessionId, "Failure test", "auto")
    const phaseId = scribe.createPhase(taskId, "backend", "backend")

    scribe.writeFailure({
      taskId,
      phaseId: String(phaseId),
      agent: "backend",
      failureType: "tool_error",
      errorMessage: "fs_write: ENOENT no such file",
      contextSummary: "trying to write to /nonexistent/path",
    })

    const rows = setup.db.query(
      "SELECT agent, failure_type, error_message FROM learning_failures WHERE task_id = ?"
    ).all(taskId) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].agent).toBe("backend")
    expect(rows[0].failure_type).toBe("tool_error")
  })

  test("getFailurePatterns agrupa fallos del mismo tipo/coordinador", () => {
    const sessionId = scribe.createSession("/tmp/pattern-project")
    const taskId = scribe.createTask(sessionId, "Pattern detection task", "auto")

    // Insertar 3 fallos del mismo tipo para el mismo coordinador
    for (let i = 0; i < 3; i++) {
      scribe.writeFailure({
        taskId,
        phaseId: null,
        agent: "architecture",
        failureType: "invalid_output",
        errorMessage: `JSON parse error: attempt ${i}`,
        contextSummary: "architecture returned truncated JSON",
      })
    }

    const patterns = scribe.getFailurePatterns({ minOccurrences: 2 })
    const archPattern = patterns.find(p => p.agent === "architecture" && p.failureType === "invalid_output")
    expect(archPattern).not.toBeUndefined()
    expect(archPattern!.count).toBeGreaterThanOrEqual(3)
  })

  test("writeDecision persiste ADR en code_decisions", () => {
    const sessionId = scribe.createSession("/tmp/adr-project")
    const taskId = scribe.createTask(sessionId, "ADR test task", "plan")

    scribe.writeDecision({
      id: Bun.randomUUIDv7(),
      taskId,
      title: "REST vs GraphQL for data API",
      context: "Need to expose task data to external consumers",
      options: "REST (simple, cached) vs GraphQL (flexible, complex)",
      decision: "REST — simpler for this use case, HTTP caching works",
      consequences: "Less flexible queries but faster implementation and better CDN support",
      status: "active",
    })

    const row = setup.db.query("SELECT title, decision FROM code_decisions WHERE task_id = ?")
      .get(taskId) as any
    expect(row).not.toBeNull()
    expect(row.title).toBe("REST vs GraphQL for data API")
    expect(row.decision).toContain("REST")
  })
})

// ─── compiledContext: playbook injection ─────────────────────────────────────

describe("compiledContext — inyección de playbook en el contexto del worker", () => {
  test("compileWorkerContext incluye reglas de playbook para el coordinador", async () => {
    // Seed code_playbook with rules for "backend"
    setup.db.query(`
      INSERT OR IGNORE INTO code_playbook (rule, coordinator, source, confidence, active)
      VALUES (?, ?, 'test', ?, 1)
    `).run("Always use prepared statements for DB queries to prevent SQL injection", "backend", 0.9)
    setup.db.query(`
      INSERT OR IGNORE INTO code_playbook (rule, coordinator, source, confidence, active)
      VALUES (?, ?, 'test', ?, 1)
    `).run("Prefer fs_read over shell_executor for file reading in Bun runtime", null, 0.75)

    // Access private method via cast
    const manager = new CoordinatorManager()
    const compiled = await (manager as any).compileWorkerContext(
      "backend",
      "Build a data API with authentication",
      "Previous phase: BEE decided to dispatch to backend coordinator"
    )

    expect(typeof compiled).toBe("string")
    expect(compiled.length).toBeGreaterThan(0)
    // Playbook section header
    expect(compiled).toContain("PLAYBOOK RULES")
    // The rule we seeded should appear
    expect(compiled).toMatch(/SQL injection|prepared statements/)
    // Confidence shown as percentage
    expect(compiled).toMatch(/\d+%/)
  })

  test("compileWorkerContext incluye sección de narrativa previa", async () => {
    const manager = new CoordinatorManager()
    const prevNarrative = "BEE: dispatched to backend. ProductManager: PRD defined."

    const compiled = await (manager as any).compileWorkerContext(
      "test",
      "Write unit tests for the API",
      prevNarrative
    )

    expect(compiled).toContain("PROJECT NARRATIVE")
    expect(compiled).toContain("dispatched to backend")
  })

  test("compileWorkerContext filtra reglas por coordinador (coordinator=NULL son globales)", async () => {
    // Seed a rule specific to 'security' and a global rule
    setup.db.query(`
      INSERT OR IGNORE INTO code_playbook (rule, coordinator, source, confidence, active)
      VALUES (?, 'security', 'test', 0.95, 1)
    `).run("Never access environment variables in security audit — read code only")
    setup.db.query(`
      INSERT OR IGNORE INTO code_playbook (rule, coordinator, source, confidence, active)
      VALUES (?, NULL, 'test', 0.8, 1)
    `).run("Always validate output format before returning to coordinator manager")

    const manager = new CoordinatorManager()
    // Test with 'reviewer' — should NOT get the 'security' rule, but SHOULD get the global one
    const compiledForReviewer = await (manager as any).compileWorkerContext(
      "reviewer",
      "Review the implementation",
      ""
    )

    // Security-specific rule should NOT appear for reviewer
    expect(compiledForReviewer).not.toContain("Never access environment variables")
    // Global rule should appear for any coordinator
    expect(compiledForReviewer).toContain("validate output format")
  })
})
