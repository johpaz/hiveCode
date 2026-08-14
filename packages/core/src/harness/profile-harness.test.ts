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
