import "../setup/memory-keystore"
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseInternalCommand, type ContextState } from "../../packages/code/src/coordinator/command-parser"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { ensureHiveDb } from "../../packages/core/src/storage/bootstrap"
import { col } from "../../packages/core/src/storage/hive"
import type { ModelDoc, ProviderDoc } from "../../packages/core/src/storage/collections"
import { startSession, waitForFrame, frameText } from "../../packages/hivetui/tests/e2e/harness"
import { sendSettingsSnapshot } from "../../packages/cli/src/commands-code/tui-launcher"

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
