import "../setup/memory-keystore"
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseInternalCommand, type ContextState } from "../../packages/code/src/coordinator/command-parser"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { ensureHiveDb } from "../../packages/core/src/storage/bootstrap"
import { col } from "../../packages/core/src/storage/hive"
import type { CodeConfigDoc, ModelDoc, ProviderDoc } from "../../packages/core/src/storage/collections"
import { startSession, waitForFrame, frameText } from "../../packages/hivetui/tests/e2e/harness"
import { sendSettingsSnapshot } from "../../packages/cli/src/commands-code/tui-launcher"
import { storeProviderApiKey } from "../../packages/core/src/storage/crypto"

const originalFetch = globalThis.fetch
const previous = process.env.HIVE_DB_PATH
const provider = (): ProviderDoc => ({ id: "deepseek", name: "deepseek", base_url: "https://example.test/v1", category: "llm", num_ctx: null, num_gpu: -1, enabled: true, active: true, created_at: 0 })
const ctx = (over: Partial<ContextState> = {}): ContextState =>
  ({ sessionId: "t", activeProvider: "deepseek", activeModel: "deepseek-chat", activeMode: "approval", activeMcp: [], activeSkills: [], projectPath: "/tmp", ...over })

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = join(mkdtempSync(join(tmpdir(), "hive-refresh-")), "hivedb")
  await ensureHiveDb()
  await (await col<ProviderDoc>("providers")).put("deepseek", provider())
})
afterEach(() => { globalThis.fetch = originalFetch; closeHiveDb() })
afterAll(() => { if (previous === undefined) delete process.env.HIVE_DB_PATH; else process.env.HIVE_DB_PATH = previous })

test("/modelo refresh brings in the provider's models and windows and says the active model's", async () => {
  // The row was written earlier with the default window; the provider publishes the real one.
  await (await col<ModelDoc>("models")).put("deepseek-chat", { id: "deepseek-chat", provider_id: "deepseek", name: "deepseek-chat", model_type: "llm", context_window: 32768, capabilities: null, enabled: true, active: false })
  globalThis.fetch = (async () => Response.json({ data: [{ id: "deepseek-chat", context_length: 131072 }, { id: "deepseek-new", context_length: 65536 }] })) as unknown as typeof fetch

  const result = await parseInternalCommand("/modelo refresh", undefined, ctx())

  expect(result.output).toContain("Modelos de deepseek actualizados: 2")
  expect(result.output).toMatch(/Ventana de deepseek-chat: 131\D?072 tokens/)
  expect((await (await col<ModelDoc>("models")).get("deepseek-chat"))!.doc.context_window).toBe(131072)
  expect((await (await col<ModelDoc>("models")).get("deepseek-new"))!.doc.context_window).toBe(65536)
})

test("/modelo refresh names the provider when asked, and reports a failure without crashing", async () => {
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
  const failed = await parseInternalCommand("/modelo refresh deepseek", undefined, ctx({ activeProvider: "", activeModel: "" }))
  expect(failed.output).toContain("No se pudo actualizar deepseek")

  const none = await parseInternalCommand("/modelo refresh", undefined, ctx({ activeProvider: "", activeModel: "" }))
  expect(none.output).toContain("No hay provider activo")
})

test("after a refresh the picker offers what the provider lists now — the new model in, the dropped one out", async () => {
  await storeProviderApiKey("deepseek", "test-key") // the picker only offers providers that have a key
  const models = await col<ModelDoc>("models")
  const row = (id: string): ModelDoc => ({ id, provider_id: "deepseek", name: id, model_type: "llm", context_window: 1000, capabilities: null, enabled: true, active: false })
  await models.put("keep", row("keep"))
  await models.put("dropped", row("dropped"))
  globalThis.fetch = (async () => Response.json({ data: [{ id: "keep", context_length: 1000 }, { id: "brand-new", context_length: 2000 }] })) as unknown as typeof fetch

  await parseInternalCommand("/modelo refresh deepseek", undefined, ctx())

  let options: string[] = []
  await parseInternalCommand("/modelo set deepseek", undefined, ctx(), {
    showConfigModal: async (_id: string, _title: string, fields: Array<{ options?: string[] }>) => { options = fields[0].options ?? []; return null },
  } as any)
  expect(options).toContain("keep")
  expect(options).toContain("brand-new")
  expect(options).not.toContain("dropped") // the provider no longer lists it

  // Naming the dropped model directly is refused the same way.
  const direct = await parseInternalCommand("/modelo set deepseek dropped", undefined, ctx())
  expect(direct.output).toContain("no está disponible")
})

test("the Models tab of the real TUI lists what the refresh brought into the database", async () => {
  await (await col<CodeConfigDoc>("codeConfig")).put("default_provider", { key: "default_provider", value: "deepseek", updated_at: Date.now() })
  const models = await col<ModelDoc>("models")
  const row = (id: string): ModelDoc => ({ id, provider_id: "deepseek", name: id, model_type: "llm", context_window: 1000, capabilities: null, enabled: true, active: false })
  await models.put("model-kept", row("model-kept"))
  await models.put("model-dropped", row("model-dropped"))
  globalThis.fetch = (async () => Response.json({ data: [{ id: "model-kept", context_length: 1000 }, { id: "model-brand-new", context_length: 2000 }] })) as unknown as typeof fetch
  await parseInternalCommand("/modelo refresh deepseek", undefined, ctx())

  let snapshot: any
  await sendSettingsSnapshot(msg => { snapshot = msg }) // what the TUI is sent right after the command
  const listed: string[] = snapshot.providers.find((p: any) => p.id === "deepseek").models
  expect(listed).toContain("model-brand-new")
  expect(listed).not.toContain("model-dropped")

  const session = await startSession("approval", { cols: 140, rows: 40 })
  try {
    session.type("\x1bOQ")
    await session.ipc.waitForMessage("request_settings")
    session.ipc.send(snapshot)
    await waitForFrame(session.iter, f => !frameText(f).includes("Cargando") && frameText(f).toLowerCase().includes("deepseek"), 5000, "snapshot cargado")
    session.type("\t") // Modelos
    const frame = await waitForFrame(session.iter, f => frameText(f).includes("model-brand-new"), 5000, "la pestaña Modelos lista el modelo nuevo")
    expect(frameText(frame)).toContain("model-kept")
    expect(frameText(frame)).not.toContain("model-dropped")
  } finally { session.dispose() }
}, 20000)

test("the TUI's refresh key asks for exactly that command", async () => {
  await sendSettingsSnapshot(() => {}) // the snapshot builder runs against this database
  let snapshot: any
  await sendSettingsSnapshot(msg => { snapshot = msg })
  const active = snapshot.providers.find((p: any) => p.id === "deepseek")
  expect(active).toBeDefined()
  // Make deepseek the active provider with a model, as the Models tab needs.
  snapshot.providers = snapshot.providers.map((p: any) => ({ ...p, is_active: p.id === "deepseek", ...(p.id === "deepseek" ? { model: p.models[0] ?? "deepseek-chat", models: p.models.length ? p.models : ["deepseek-chat"] } : {}) }))

  const session = await startSession("approval", { cols: 130, rows: 40 })
  try {
    session.type("\x1bOQ")
    await session.ipc.waitForMessage("request_settings")
    session.ipc.send(snapshot)
    await waitForFrame(session.iter, f => !frameText(f).includes("Cargando") && frameText(f).toLowerCase().includes("deepseek"), 5000, "snapshot cargado")
    session.type("\t") // Modelos
    const models = await waitForFrame(session.iter, f => frameText(f).includes("Actualizar modelos"), 5000, "botón Actualizar modelos")
    expect(frameText(models)).toContain("U: actualizar modelos")
    session.type("u")
    expect((await session.ipc.waitForMessage("submit")).input).toBe("/modelo refresh deepseek")
  } finally { session.dispose() }
}, 20000)
