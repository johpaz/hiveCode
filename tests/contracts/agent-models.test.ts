import "../setup/memory-keystore"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { ensureHiveDb } from "../../packages/core/src/storage/bootstrap"
import { col, fromIndexable, mutateDoc } from "../../packages/core/src/storage/hive"
import type { AgentDoc, CodeConfigDoc, ModelDoc } from "../../packages/core/src/storage/collections"
import { repairKnownContextWindows } from "../../packages/core/src/services/model-windows"
import { applyModelToAllAgents, describeApplied } from "../../packages/core/src/services/agent-models"
import { INHERIT_MODEL, agentConfigFields, agentModelPatch } from "../../packages/cli/src/commands-code/agent-settings"

const previous = process.env.HIVE_DB_PATH

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = join(mkdtempSync(join(tmpdir(), "hive-agent-models-")), "hivedb")
  await ensureHiveDb()
})
afterEach(() => closeHiveDb())
afterAll(() => {
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

const coreAgents = async () => (await (await col<AgentDoc>("agents")).scan()).map(e => e.doc).filter(a => !!a.agent_type)

describe("applyModelToAllAgents", () => {
  test("every core agent follows the chosen model, and an agent with its own loses it", async () => {
    await mutateDoc<AgentDoc>("agents", "bee", row => row && { ...row, model_selection: "custom", provider_id: "opencode-go", model_id: "opencode-go/longcat-2.0" })

    const result = await applyModelToAllAgents("opencode-go", "opencode-go/minimax-m3.1-flash-free")

    const agents = await coreAgents()
    expect(agents.length).toBe(6)
    expect(result.updated).toBe(6)
    expect(result.replaced).toEqual(["bee"])
    for (const agent of agents) {
      expect(agent.model_selection).toBe("inherit")
      expect(fromIndexable(agent.provider_id)).toBe("opencode-go")
      expect(fromIndexable(agent.model_id)).toBe("opencode-go/minimax-m3.1-flash-free")
    }
  })

  test("says what it did, and names the agents whose own model it replaced", async () => {
    await mutateDoc<AgentDoc>("agents", "builder", row => row && { ...row, model_selection: "custom" })
    const text = describeApplied(await applyModelToAllAgents("opencode-go", "opencode-go/minimax-m3"))
    expect(text).toBe("aplicado a 6 agentes (sustituyó el modelo propio de builder)")
    expect(describeApplied(await applyModelToAllAgents("opencode-go", "opencode-go/minimax-m3"))).toBe("aplicado a 6 agentes")
  })

  test("an agent can be given its own model again afterwards", async () => {
    await applyModelToAllAgents("opencode-go", "opencode-go/minimax-m3")
    await mutateDoc<AgentDoc>("agents", "scout", row => row && { ...row, model_selection: "custom", provider_id: "deepseek", model_id: "deepseek-flash" })
    const scout = (await (await col<AgentDoc>("agents")).get("scout"))!.doc
    expect(scout.model_selection).toBe("custom")
    expect(fromIndexable(scout.model_id)).toBe("deepseek-flash")
  })
})

describe("the agent editor", () => {
  test("offers the model, the fallback and the instructions — and nothing that does not work", async () => {
    const bee = (await (await col<AgentDoc>("agents")).get("bee"))!.doc
    const keys = (await agentConfigFields(bee)).map(field => field.key)
    expect(keys).toEqual(["model_choice", "fallback_provider", "fallback_model", "user_instructions"])
  })

  test("going back to the session's model mirrors it, so an older choice does not linger", async () => {
    const config = await col<CodeConfigDoc>("codeConfig")
    const row = (key: string, value: string) => ({ key, value, created_at: 0, updated_at: 0 })
    await config.put("default_provider", row("default_provider", "opencode-go"))
    await config.put("provider_model_opencode-go", row("provider_model_opencode-go", "opencode-go/minimax-m3.1-flash-free"))

    const patch = await agentModelPatch(INHERIT_MODEL)
    expect(patch.model_selection).toBe("inherit")
    expect(fromIndexable(patch.provider_id)).toBe("opencode-go")
    expect(fromIndexable(patch.model_id)).toBe("opencode-go/minimax-m3.1-flash-free")
  })
})

describe("repairKnownContextWindows", () => {
  const window = async (id: string) => (await (await col<ModelDoc>("models")).get(id))?.doc.context_window

  test("fixes a window the provider never published, leaves one the provider reported, and is idempotent", async () => {
    const models = await col<ModelDoc>("models")
    const row = (id: string, provider_id: string, context_window: number): ModelDoc =>
      ({ id, provider_id, name: id, model_type: "llm", context_window, capabilities: null, enabled: true, active: false })
    await models.put("opencode-go/minimax-m3.1-flash-free", row("opencode-go/minimax-m3.1-flash-free", "opencode-go", 32768)) // what the sync wrote
    await models.put("opencode-go/minimax-m2.7", row("opencode-go/minimax-m2.7", "opencode-go", 1_000_000)) // stale
    await models.put("gemini-x", row("gemini-x", "gemini", 1_048_576)) // reported by Gemini itself

    expect(await repairKnownContextWindows()).toBe(2)
    expect(await window("opencode-go/minimax-m3.1-flash-free")).toBe(1_000_000)
    expect(await window("opencode-go/minimax-m2.7")).toBe(204_800)
    expect(await window("gemini-x")).toBe(1_048_576)
    expect(await repairKnownContextWindows()).toBe(0)
  })

  test("startup repairs it on its own", async () => {
    const models = await col<ModelDoc>("models")
    const current = (await models.get("opencode-go/minimax-m3.1-flash-free"))
    await models.put("opencode-go/minimax-m3.1-flash-free", { ...(current?.doc as ModelDoc), context_window: 32768 }, { expectedVersion: current?.version ?? 0 })
    await ensureHiveDb()
    expect(await window("opencode-go/minimax-m3.1-flash-free")).toBe(1_000_000)
  })
})
