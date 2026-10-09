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
    expect(await discoverProviderModels(provider(), "test-key")).toEqual([{ id: "new", name: undefined, type: undefined, context: undefined }])
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
