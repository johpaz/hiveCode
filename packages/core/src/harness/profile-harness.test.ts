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
