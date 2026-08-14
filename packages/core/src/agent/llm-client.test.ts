import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "../storage/hive"
import { closeHiveDb } from "../storage/hivedb"
import type { ModelDoc } from "../storage/collections"
import { resolveCallOptionsFromDb } from "./llm-client"

const previousHiveDbPath = process.env.HIVE_DB_PATH
const modelId = "dynamic-context-test-model"

beforeAll(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(
    mkdtempSync(path.join(tmpdir(), "hivecode-llm-context-")),
    "hivedb",
  )
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

describe("LLM context window resolution", () => {
  test("reads the current model context_window from HiveDB for every call", async () => {
    const models = await col<ModelDoc>("models")
    const baseModel: ModelDoc = {
      id: modelId,
      provider_id: "any-provider",
      name: "Dynamic context model",
      model_type: "llm",
      context_window: 12000,
      capabilities: null,
      enabled: true,
      active: true,
    }
    await models.put(modelId, baseModel, { expectedVersion: 0 })

    const options = {
      provider: "any-provider",
      model: modelId,
      apiKey: "test",
      contextWindow: 999,
      messages: [{ role: "user" as const, content: "hello" }],
    }
    expect((await resolveCallOptionsFromDb(options)).contextWindow).toBe(12000)

    const current = await models.get(modelId)
    await models.put(
      modelId,
      { ...baseModel, context_window: 50000 },
      { expectedVersion: current!.version },
    )

    expect((await resolveCallOptionsFromDb(options)).contextWindow).toBe(50000)
  })
})
