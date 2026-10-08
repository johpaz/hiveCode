import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { col } from "../storage/hive.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import type { AgentDoc } from "../storage/collections.ts"
import { HIVEAGENTS_MODEL_ID } from "../agent/llm-providers/hiveagents.ts"
import { DEFAULT_MAX_HARNESS_STEPS, ProfileHarness, type ProfileRunner } from "./profile-harness.ts"

const previousHiveDbPath = process.env.HIVE_DB_PATH

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(
    mkdtempSync(path.join(tmpdir(), "hivecode-profile-harness-")),
    "hivedb",
  )
  await ensureHiveDb()
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

describe("profile harness task routing", () => {
  test("uses the provider selected for the task and forwards live steps", async () => {
    const events: Array<{
      type: string
      agent?: string
      phase?: string
      toolName?: string
      message: string
    }> = []
    const runner: ProfileRunner = async options => {
      expect(options.maxSteps).toBe(DEFAULT_MAX_HARNESS_STEPS)
      await options.onStep?.({
        type: "tool_call",
        toolName: "web_search",
        message: "Executing: `web_search`",
      })
      return "respuesta lista"
    }

    const result = await new ProfileHarness(runner).run({
      objective: "hola",
      sessionId: "session-test",
      workspace: "/workspace/test",
      provider: "hiveagents",
      model: HIVEAGENTS_MODEL_ID,
      onEvent: event => events.push(event),
    })

    expect(result.response).toBe("respuesta lista")
    expect(events).toContainEqual({
      type: "agent_progress",
      agent: "bee",
      phase: "tool_call",
      toolName: "web_search",
      message: "Executing: `web_search`",
    })

    const bee = (await (await col<AgentDoc>("agents")).get("bee"))?.doc
    expect(bee?.provider_id).toBe("hiveagents")
    expect(bee?.model_id).toBe(HIVEAGENTS_MODEL_ID)
  })
})

describe("approval gate", () => {
  // "migración" dispara complexity=complex → pasa por planning y llega al gate.
  const COMPLEX_OBJECTIVE = "planifica la migración de arquitectura del módulo de auth"
  const planningRunner: ProfileRunner = async () => "Plan listo.\nFEATURE_DIR: specs/001-auth"

  test("waits for the user instead of cancelling when no approver is wired", async () => {
    // El recovery scheduler reencola con manager.runTask(task, mode) sin approver.
    // Tratar 'nadie puede responder' como 'rechazado' descartaba el trabajo en silencio.
    const result = await new ProfileHarness(planningRunner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-approval",
      workspace: "/workspace/test",
      policy: "approval",
    })

    expect(result.status).toBe("waiting_user")
  })

  test("cancels when the user actually rejects", async () => {
    const result = await new ProfileHarness(planningRunner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-approval-reject",
      workspace: "/workspace/test",
      policy: "approval",
      approve: async () => "cancel",
    })

    expect(result.status).toBe("cancelled")
  })
})

describe("BEE-led execution", () => {
  const COMPLEX_OBJECTIVE = "planifica la migración de arquitectura del módulo de auth"

  function scripted(outputs: string[]) {
    const calls: Array<{ agentId: string; task: string; approvedExecution?: boolean }> = []
    const runner: ProfileRunner = async options => {
      calls.push({ agentId: options.agentId, task: options.taskDescription, approvedExecution: options.approvedExecution })
      return outputs[calls.length - 1] ?? "ok"
    }
    return { calls, runner }
  }

  test("plans through the planner, executes under BEE with approval, converges", async () => {
    const { calls, runner } = scripted([
      "Plan listo.\nFEATURE_DIR: specs/001-auth",
      "Hecho en paralelo.\nVERDICT: PASS",
      "Convergido.",
    ])
    const result = await new ProfileHarness(runner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-bee-led",
      workspace: "/workspace/test",
      policy: "auto",
    })

    expect(result).toMatchObject({ status: "completed", featureDir: "specs/001-auth", repairCycles: 0 })
    // Only BEE is invoked by the harness: workers are BEE's to delegate to.
    expect(calls.map(call => call.agentId)).toEqual(["bee", "bee", "bee"])
    expect(calls[0]!.task).toContain('worker_id="planner"')
    expect(calls[1]!.task).toContain("EN EL MISMO PASO")
    expect(calls[1]!.approvedExecution).toBe(true)
  })

  test("sends a failed quality gate back through a repair cycle", async () => {
    const { calls, runner } = scripted([
      "FEATURE_DIR: specs/002-auth",
      "Falló.\nVERDICT: FAIL",
      "Reparado.\nVERDICT: PASS",
      "Convergido.",
    ])
    const result = await new ProfileHarness(runner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-repair",
      workspace: "/workspace/test",
      policy: "auto",
    })

    expect(result).toMatchObject({ status: "completed", repairCycles: 1 })
    expect(calls[2]!.task).toContain("Ciclo de reparación 1/")
    expect(calls[2]!.task).toContain("VERDICT: FAIL")
  })

  test("fails when the quality gate never converges", async () => {
    const { runner } = scripted(["FEATURE_DIR: specs/003-auth", ...Array(6).fill("VERDICT: FAIL")])
    await expect(new ProfileHarness(runner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-no-converge",
      workspace: "/workspace/test",
      policy: "auto",
    })).rejects.toThrow("did not converge")
  })

  test("a small change is delegated to the builder by BEE, without Spec Kit", async () => {
    const { calls, runner } = scripted(["Cambio aplicado."])
    const result = await new ProfileHarness(runner).run({
      objective: "corrige el typo en el README",
      sessionId: "session-simple",
      workspace: "/workspace/test",
    })
    expect(result.complexity).toBe("simple_change")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.agentId).toBe("bee")
    expect(calls[0]!.task).toContain('worker "builder"')
  })
})
