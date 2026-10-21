import "../setup/memory-keystore";
import { listCatalogModels, listCatalogProviders } from "../../packages/core/src/services/provider-catalog-read"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { col, ensureIndexes } from "../../packages/core/src/storage/hive"
import type { CodeConfigDoc, ModelDoc, ProviderDoc } from "../../packages/core/src/storage/collections"
import { discoverProviderModels, latestCatalogSlot, reconcileProviderModels, runDueProviderCatalogSync } from "../../packages/core/src/services/provider-catalog"
import { seedAllData } from "../../packages/core/src/storage/seed"

const originalFetch = globalThis.fetch
const oldPath = process.env.HIVE_DB_PATH
const sunday = Date.parse("2026-10-11T07:00:00Z")
const provider = (id = "deepseek"): ProviderDoc => ({ id, name: id, base_url: "https://example.test/api/paas/v4", category: "llm", num_ctx: null, num_gpu: -1, enabled: true, active: true, created_at: 0 })
const model = (id: string, provider_id = "deepseek"): ModelDoc => ({ id, provider_id, name: id, model_type: "llm", context_window: 1000, capabilities: "custom", enabled: false, active: false })
beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-catalog-"))
  await ensureIndexes([["models", "provider_id"]])
})
afterEach(() => { globalThis.fetch = originalFetch; closeHiveDb() })
afterAll(() => { if (oldPath === undefined) delete process.env.HIVE_DB_PATH; else process.env.HIVE_DB_PATH = oldPath })

describe("weekly catalog", () => {
  test("Sunday 02:00 Colombia boundary, independent of host timezone", () => {
    expect(latestCatalogSlot(sunday - 1)).toBe(sunday - 7 * 86400000)
    expect(latestCatalogSlot(sunday)).toBe(sunday)
    expect(latestCatalogSlot(sunday + 6 * 86400000)).toBe(sunday)
  })
  test("preserves versioned base URL and authenticates discovery", async () => {
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://example.test/api/paas/v4/models")
      expect((init?.headers as any).Authorization).toBe("Bearer test-key")
      return Response.json({ data: [{ id: "new" }] })
    }) as unknown as typeof fetch
    expect(await discoverProviderModels(provider(), "test-key")).toEqual([{ id: "new", name: undefined, type: undefined, context: undefined, capabilities: ["code"] }])
  })
  test("Anthropic consumes every page using native auth", async () => {
    let calls = 0
    globalThis.fetch = (async (url, init) => {
      expect((init?.headers as any)["x-api-key"]).toBe("test-key")
      calls++
      if (calls === 1) return Response.json({ data: [{ id: "claude-one" }], has_more: true, last_id: "claude-one" })
      expect(new URL(String(url)).searchParams.get("after_id")).toBe("claude-one")
      return Response.json({ data: [{ id: "claude-two" }], has_more: false })
    }) as unknown as typeof fetch
    expect((await discoverProviderModels({ ...provider("anthropic"), base_url: "https://example.test" }, "test-key")).map(m => m.id)).toEqual(["claude-one", "claude-two"])
  })
  test("Gemini default URL, pagination and native model names", async () => {
    let calls = 0
    globalThis.fetch = (async (url, init) => {
      expect((init?.headers as any)["x-goog-api-key"]).toBe("test-key")
      expect(String(url)).toContain("https://generativelanguage.googleapis.com/v1beta/models")
      if (++calls === 1) return Response.json({ models: [{ name: "models/gemini-test", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1234 }], nextPageToken: "next" })
      expect(new URL(String(url)).searchParams.get("pageToken")).toBe("next")
      return Response.json({ models: [{ name: "models/embed-test", supportedGenerationMethods: ["embedContent"] }] })
    }) as unknown as typeof fetch
    const result = await discoverProviderModels({ ...provider("gemini"), base_url: null }, "test-key")
    expect(result[0].id).toBe("gemini-test")
    expect(result[0].context).toBe(1234)
    expect(result[1].type).toBe("embedding")
  })
  test("rejects malformed, empty and truncated catalogs", async () => {
    for (const body of [{}, { data: [] }, { data: [{}] }, { data: [], has_more: true }]) {
      globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch
      await expect(discoverProviderModels(provider(), null)).rejects.toThrow()
    }
  })
  test("OpenCode Go: the curated window repairs a 32 768 placeholder or a stale value, and fills a new row", async () => {
    const models = await col<ModelDoc>("models")
    const goModel = (id: string, context_window: number): ModelDoc =>
      ({ ...model(`opencode-go/${id}`, "opencode-go"), context_window, catalog_managed: true, catalog_wire_id: id })
    await models.put("opencode-go/minimax-m3.1-flash-free", goModel("minimax-m3.1-flash-free", 32768)) // placeholder written by an earlier sync
    await models.put("opencode-go/minimax-m2.7", goModel("minimax-m2.7", 1_000_000)) // stale: the real window is 204 800
    // The gateway lists ids only: no window anywhere in the payload.
    await reconcileProviderModels(provider("opencode-go"), [{ id: "minimax-m3.1-flash-free" }, { id: "minimax-m2.7" }, { id: "minimax-m3" }, { id: "not-in-the-catalog" }], sunday)
    expect((await models.get("opencode-go/minimax-m3.1-flash-free"))?.doc.context_window).toBe(1_000_000)
    expect((await models.get("opencode-go/minimax-m2.7"))?.doc.context_window).toBe(204_800)
    expect((await models.get("opencode-go/minimax-m3"))?.doc.context_window).toBe(1_000_000)
    // A model the catalog does not know keeps the old default rather than an invented window.
    expect((await models.get("opencode-go/not-in-the-catalog"))?.doc.context_window).toBe(32768)
  })
  test("what the provider publishes today wins over a stale or zero stored window", async () => {
    const models = await col<ModelDoc>("models")
    await models.put("stale", { ...model("stale"), context_window: 262144 }) // stored larger than the real one
    await models.put("zero", { ...model("zero"), context_window: 0 }) // "unknown", written by an older sync
    await models.put("same", { ...model("same"), context_window: 4096 })
    await reconcileProviderModels(provider(), [{ id: "stale", context: 131072 }, { id: "zero", context: 8192 }, { id: "same", context: 4096 }, { id: "brand-new", context: 65536 }], sunday)
    expect((await models.get("stale"))?.doc.context_window).toBe(131072)
    expect((await models.get("zero"))?.doc.context_window).toBe(8192)
    expect((await models.get("same"))?.doc.context_window).toBe(4096)
    expect((await models.get("brand-new"))?.doc.context_window).toBe(65536)
  })
  test("with no published window, a stored one is kept only if it is valid", async () => {
    const models = await col<ModelDoc>("models")
    await models.put("kept", { ...model("kept"), context_window: 7777 })
    await models.put("invalid", { ...model("invalid"), context_window: 0 })
    await reconcileProviderModels(provider(), [{ id: "kept" }, { id: "invalid" }], sunday)
    expect((await models.get("kept"))?.doc.context_window).toBe(7777)
    expect((await models.get("invalid"))?.doc.context_window).toBe(32768) // the default, not a 0 that means nothing
  })
  test("other providers keep their stored window: only the curated OpenCode Go catalog overrides", async () => {
    const models = await col<ModelDoc>("models")
    await models.put("minimax-m3.1-flash-free", { ...model("minimax-m3.1-flash-free", "deepseek"), context_window: 7777 })
    await reconcileProviderModels(provider("deepseek"), [{ id: "minimax-m3.1-flash-free" }], sunday)
    expect((await models.get("minimax-m3.1-flash-free"))?.doc.context_window).toBe(7777)
  })
  test("preserves manual choices, isolates provider IDs and deprecates after two weekly slots", async () => {
    const models = await col<ModelDoc>("models")
    await models.put("present", model("present"))
    await models.put("old", { ...model("old"), enabled: true, active: true })
    await models.put("shared", model("shared", "openai"))
    await reconcileProviderModels(provider(), [{ id: "present" }, { id: "shared" }], sunday)
    expect((await models.get("present"))!.doc).toMatchObject({ enabled: false, active: false, context_window: 1000, capabilities: "custom" })
    expect((await models.get("shared"))!.doc.provider_id).toBe("openai")
    expect((await models.get("deepseek/shared"))!.doc.provider_id).toBe("deepseek")
    await reconcileProviderModels(provider(), [{ id: "present" }], sunday + 1000)
    expect((await models.get("old"))!.doc.active).toBe(true)
    await reconcileProviderModels(provider(), [{ id: "present" }], sunday + 7 * 86400000)
    expect((await models.get("old"))!.doc).toMatchObject({ active: false, enabled: false, deprecated_at: sunday + 7 * 86400000 })
    await reconcileProviderModels(provider(), [{ id: "old" }], sunday + 8 * 86400000)
    expect((await models.get("old"))!.doc).toMatchObject({ active: false, deprecated_at: null })
  })
  test("onboarding/settings DB catalog includes discoveries and excludes disabled, deprecated and non-LLM models", async () => {
    const providers = await col<ProviderDoc>("providers")
    await providers.put("deepseek", provider())
    await providers.put("voice", { ...provider("voice"), category: "tts" })
    await reconcileProviderModels(provider(), [{ id: "fresh-model" }], sunday)
    const models = await col<ModelDoc>("models")
    await models.put("disabled", model("disabled"))
    await models.put("retired", { ...model("retired"), enabled: true, deprecated_at: sunday })
    await models.put("embed", { ...model("embed"), enabled: true, model_type: "embedding" })
    expect((await listCatalogProviders()).map(p => p.id)).toEqual(["deepseek"])
    expect((await listCatalogModels("deepseek")).map(m => m.id)).toEqual(["fresh-model"])
    // Changes in DB are reflected on the next read; no seed/static options cache.
    const fresh = (await models.get("fresh-model"))!
    await models.put(fresh.id, { ...fresh.doc, enabled: false }, { expectedVersion: fresh.version })
    expect(await listCatalogModels("deepseek")).toEqual([])
  })
  test("a configured default provider syncs even on legacy rows with active=false", async () => {
    await (await col<ProviderDoc>("providers")).put("deepseek", { ...provider(), active: false })
    await (await col<CodeConfigDoc>("codeConfig")).put("default_provider", { key: "default_provider", value: "deepseek", updated_at: sunday })
    globalThis.fetch = (async () => Response.json({ data: [{ id: "legacy-new" }] })) as unknown as typeof fetch
    await runDueProviderCatalogSync(sunday)
    expect((await listCatalogModels("deepseek")).map(m => m.id)).toEqual(["legacy-new"])
  })
  test("a catalog whose last success is over a day old is brought up to date, even inside the same weekly slot", async () => {
    await (await col<ProviderDoc>("providers")).put("deepseek", provider())
    let fetches = 0
    globalThis.fetch = (async () => { fetches++; return Response.json({ data: [{ id: "m", context_length: 1000 }] }) }) as unknown as typeof fetch
    const HOUR = 3600000
    await runDueProviderCatalogSync(sunday)
    expect(fetches).toBe(1)
    await runDueProviderCatalogSync(sunday + 23 * HOUR) // fresh enough: nothing to do
    expect(fetches).toBe(1)
    await runDueProviderCatalogSync(sunday + 25 * HOUR) // same Sunday slot, but a day old: due
    expect(fetches).toBe(2)
    await runDueProviderCatalogSync(sunday + 26 * HOUR) // just refreshed
    expect(fetches).toBe(2)
  })
  test("boot seed preserves managed models and customized provider URLs", async () => {
    await (await col<ProviderDoc>("providers")).put("deepseek", provider())
    await reconcileProviderModels(provider(), [{ id: "dynamic-model" }], sunday)
    await seedAllData()
    expect((await (await col<ModelDoc>("models")).get("dynamic-model"))!.doc.catalog_managed).toBe(true)
    expect((await (await col<ProviderDoc>("providers")).get("deepseek"))!.doc.base_url).toBe(provider().base_url)
  })
  test("catch-up persists completion; failures retain catalog and retry after one hour", async () => {
    await (await col<ProviderDoc>("providers")).put("deepseek", provider())
    await (await col<ModelDoc>("models")).put("old", { ...model("old"), enabled: true, active: true })
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response("unauthorized", { status: 401 }) }) as unknown as typeof fetch
    await runDueProviderCatalogSync(sunday)
    await runDueProviderCatalogSync(sunday + 1000)
    expect(calls).toBe(1)
    expect((await (await col<ModelDoc>("models")).get("old"))!.doc.active).toBe(true)
    globalThis.fetch = (async () => { calls++; return Response.json({ data: [{ id: "old" }] }) }) as unknown as typeof fetch
    await runDueProviderCatalogSync(sunday + 3600000)
    await runDueProviderCatalogSync(sunday + 7200000)
    expect(calls).toBe(2)
    const state = await (await col<CodeConfigDoc>("codeConfig")).get("provider_catalog.deepseek")
    expect(JSON.parse(state!.doc.value!).completed_slot).toBe(sunday)
  })
})


test("agent editor offers discovered models from the selected provider without activating them globally", async () => {
  const {agentConfigFields, agentModelPatch, INHERIT_MODEL} = await import("../../packages/cli/src/commands-code/agent-settings")
  const {ensureCoreAgentProfiles} = await import("../../packages/core/src/agent/agent-profiles")
  const {ensureHiveDb} = await import("../../packages/core/src/storage/bootstrap")
  await ensureHiveDb(); await ensureCoreAgentProfiles()
  const config = await col<CodeConfigDoc>("codeConfig")
  await config.put("default_provider", {key: "default_provider", value: "gemini", updated_at: sunday})
  await reconcileProviderModels({...provider("gemini"), base_url: null}, [{id: "gemini-test-new-flash", name: "Gemini Current Flash"}], sunday)
  const agents = await col<import("../../packages/core/src/storage/collections").AgentDoc>("agents")
  const builder = (await agents.get("builder"))!.doc
  await (await col<ProviderDoc>("providers")).put("secondary", {...provider("secondary"), active: false})
  await reconcileProviderModels(provider("secondary"), [{id: "secondary-code", name: "Secondary Coder"}], sunday)
  await (await col<ModelDoc>("models")).put("secondary-disabled", {...model("secondary-disabled"), provider_id: "secondary", enabled: false})
  const fields = await agentConfigFields({...builder, max_input_tokens: 12345, user_instructions: "Mantener contratos"})
  expect(fields[0]).toMatchObject({field_type: "select", default_value: INHERIT_MODEL})
  expect(fields[0].options).toContain("Gemini Current Flash · gemini/gemini-test-new-flash")
  expect(fields[0].options).toContain("Secondary Coder · secondary/secondary-code")
  expect(fields[0].options?.some(option => option.includes("secondary-disabled"))).toBe(false)
  expect(await agentModelPatch("Gemini Current Flash · gemini/gemini-test-new-flash")).toEqual({provider_id: "gemini", model_id: "gemini-test-new-flash", model_selection: "custom"})
  const customFields = await agentConfigFields({...builder, provider_id: "gemini", model_id: "gemini-test-new-flash", model_selection: "custom"})
  expect(customFields[0].default_value).toBe("Gemini Current Flash · gemini/gemini-test-new-flash")
  // Limits and effort are not editable per agent: the harness decides them by route and phase.
  expect(fields.map(field => field.key)).not.toContain("max_input_tokens")
  expect(fields.map(field => field.key)).not.toContain("effort")
  expect(fields.find(field => field.key === "user_instructions")?.default_value).toBe("Mantener contratos")
  const patch = await agentModelPatch("gemini/gemini-test-new-flash")
  expect(patch).toEqual({provider_id: "gemini", model_id: "gemini-test-new-flash", model_selection: "custom"})
  expect((await (await col<ModelDoc>("models")).get("gemini-test-new-flash"))!.doc.active).toBe(false)
  await agents.put("builder", {...builder, ...patch})
  await ensureCoreAgentProfiles()
  expect((await agents.get("builder"))!.doc.model_selection).toBe("custom")
  const {ProfileHarness} = await import("../../packages/core/src/harness/profile-harness")
  await new ProfileHarness(async () => "Listo").run({objective: "hola", sessionId: "model-fixture", workspace: "/tmp/model-fixture", provider: "hiveagents", model: "session-model"})
  expect((await agents.get("builder"))!.doc).toMatchObject(patch)
  expect((await agents.get("bee"))!.doc.model_id).toBe("session-model")
  const bee = (await agents.get("bee"))!.doc
  await agents.put("bee", {...bee, ...patch})
  const {setCoordinatorProviderModel} = await import("../../packages/cli/src/commands-code/provider-store")
  await setCoordinatorProviderModel("hiveagents", "another-global-model")
  expect((await agents.get("bee"))!.doc).toMatchObject(patch)
  await expect(agentModelPatch("gemini/missing-model")).rejects.toThrow("catálogo")
  expect(await agentModelPatch(INHERIT_MODEL)).toEqual({model_selection: "inherit"})
})

test("DeepSeek discovery preserves coding and multimodal metadata and exposes unselected models", async () => {
  const deepseek = provider("deepseek")
  await (await col<ProviderDoc>("providers")).put(deepseek.id, deepseek)
  globalThis.fetch = (async () => Response.json({object: "list", data: [{
    id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", context_window: 1048576,
    max_output_tokens: 393216, input_modalities: ["text", "image"], output_modalities: ["text"],
    effort: {supported_levels: ["low", "high", "max"], default_level: "high"},
  }]})) as unknown as typeof fetch
  const remote = await discoverProviderModels(deepseek, "test-key")
  expect(remote[0]).toMatchObject({inputModalities: ["text", "image"], outputModalities: ["text"], maxOutputTokens: 393216, effortLevels: ["low", "high", "max"]})
  await reconcileProviderModels(deepseek, remote, sunday)
  const {getAvailableModelsTool} = await import("../../packages/core/src/tools/agents/get-available-models")
  const result = await getAvailableModelsTool.execute({providerId: "deepseek", capabilities: "coding"}) as any
  expect(result.ok).toBe(true)
  expect(result.models).toContainEqual(expect.objectContaining({modelId: "deepseek-flash", inputModalities: ["text", "image"], capabilities: expect.arrayContaining(["code", "vision", "multimodal"])}))
  expect((await (await col<ModelDoc>("models")).get("deepseek-flash"))!.doc.active).toBe(false)
})

test("changing a credential refreshes a completed weekly catalog before returning settings", async () => {
  const {storeProviderApiKey} = await import("../../packages/core/src/storage/crypto")
  const {handleUpdateProvider} = await import("../../packages/core/src/gateway/routes/providers")
  const {sendSettingsSnapshot} = await import("../../packages/cli/src/commands-code/tui-launcher")
  const {eventBus} = await import("../../packages/core/src/events/event-bus")
  await (await col<ProviderDoc>("providers")).put("deepseek", provider())
  await (await col<CodeConfigDoc>("codeConfig")).put("default_provider", {key:"default_provider", value:"deepseek", updated_at:sunday})
  await storeProviderApiKey("deepseek", "old-test-key")
  globalThis.fetch = (async () => Response.json({data:[{id:"previous-coding-model"}]})) as unknown as typeof fetch
  await runDueProviderCatalogSync(sunday)
  let events = 0, calls = 0
  const stop = eventBus.on("catalog:updated", event => {if(event.providerId === "deepseek") events++})
  globalThis.fetch = (async (_url, init) => {
    calls++
    expect((init?.headers as any).Authorization).toBe("Bearer new-test-key")
    return Response.json({data:[{id:"fresh-multimodal-coder", name:"Current Multimodal Coder", input_modalities:["text","image"], output_modalities:["text"]}]})
  }) as unknown as typeof fetch
  try {
    const response = await handleUpdateProvider(new Request("http://localhost/api/providers/deepseek", {method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({apiKey:"new-test-key"})}), response => response)
    expect(response.status).toBe(200)
    expect(calls).toBe(1)
    expect(events).toBe(1)
    const snapshots: any[] = []
    await sendSettingsSnapshot(message => snapshots.push(message))
    const deepseek = snapshots.find(message => message.type === "settings_data").providers.find((item:any)=>item.id === "deepseek")
    expect(deepseek.models).toEqual(["fresh-multimodal-coder"])
    expect(deepseek.model_names).toEqual({"fresh-multimodal-coder": "Current Multimodal Coder"})
    const stored = (await (await col<ModelDoc>("models")).get("fresh-multimodal-coder"))!.doc
    expect(stored.input_modalities).toEqual(["text","image"])
    expect(stored.active).toBe(false)
  } finally { stop() }
})


test("header context belongs to BEE's configured model rather than the session default", async () => {
  const {sendSettingsSnapshot} = await import("../../packages/cli/src/commands-code/tui-launcher")
  await (await col<any>("agents")).put("bee", {id:"bee", provider_id:"deepseek", model_id:"bee-model", model_selection:"custom"})
  await (await col<ModelDoc>("models")).put("bee-model", {...model("bee-model"), context_window:128000})
  await (await col<CodeConfigDoc>("codeConfig")).put("default_provider", {key:"default_provider", value:"gemini", updated_at:0})
  const messages: any[] = []
  await sendSettingsSnapshot(message => messages.push(message))
  expect(messages.find(message => message.type === "coordinator_context")).toMatchObject({
    agent:"bee", provider:"deepseek", model:"bee-model", context_window:128000, input_tokens:null,
  })
})


test("BEE's inherited header model follows configuration and restores only that session's latest input", async () => {
  const {readCoordinatorContext} = await import("../../packages/cli/src/commands-code/header-context")
  await (await col<any>("agents")).put("bee", {id:"bee", provider_id:"old-provider", model_id:"old-model", model_selection:"inherit"})
  const config = await col<CodeConfigDoc>("codeConfig")
  await config.put("default_provider", {key:"default_provider", value:"deepseek", updated_at:0})
  await config.put("provider_model_deepseek", {key:"provider_model_deepseek", value:"bee-model", updated_at:0})
  await (await col<ModelDoc>("models")).put("bee-model", {...model("bee-model"), context_window:128000})
  await (await col<any>("agentRuns")).put("r", {id:"r", agent_id:"bee", session_id:"s", input_tokens:999999, updated_at:2, created_at:1,
    context_metrics_json:JSON.stringify({model_context:{provider:"deepseek", model:"bee-model", input_tokens:32000, estimated:false}})})
  expect(await readCoordinatorContext("s")).toMatchObject({provider:"deepseek", model:"bee-model", context_window:128000, input_tokens:32000, estimated:false})
  expect((await readCoordinatorContext("other-session")).input_tokens).toBeNull()
})
