import { col, ensureIndexes } from "../storage/hive"
import type { CodeConfigDoc, ModelDoc, ProviderDoc } from "../storage/collections"
import { getProviderApiKey } from "../storage/crypto"
import { HIVEAGENTS_MODEL_ID } from "../agent/llm-providers/hiveagents"
import { logger } from "../utils/logger"

const log = logger.child("provider-catalog")
const WEEK = 7 * 24 * 60 * 60 * 1000
const RETRY = 60 * 60 * 1000
const locks = new Map<string, Promise<SyncResult>>()
// Sunday 02:00 America/Bogota is Sunday 07:00 UTC. Colombia has no DST.
const SUNDAY_ANCHOR = Date.UTC(1970, 0, 4, 7)
export function latestCatalogSlot(now = Date.now()): number {
  return SUNDAY_ANCHOR + Math.floor((now - SUNDAY_ANCHOR) / WEEK) * WEEK
}

interface RemoteModel { id: string; name?: string; context?: number; type?: ModelDoc["model_type"] }
interface SyncState { completed_slot?: number; attempted_at?: number; succeeded_at?: number; error?: string; synced?: number; deprecated?: number }
interface SyncResult { synced: number; deprecated: number; skipped?: string }
const stateKey = (id: string) => `provider_catalog.${id}`

async function readState(id: string): Promise<SyncState> {
  const row = await (await col<CodeConfigDoc>("codeConfig")).get(stateKey(id))
  return row?.doc.value ? JSON.parse(row.doc.value) : {}
}
async function saveState(id: string, state: SyncState): Promise<void> {
  const config = await col<CodeConfigDoc>("codeConfig")
  const key = stateKey(id)
  const row = await config.get(key)
  await config.put(key, { key, value: JSON.stringify(state), updated_at: Date.now() }, { expectedVersion: row?.version ?? 0 })
}

/** Complete, validated snapshots only. Errors on any page prevent reconciliation. */
export async function discoverProviderModels(provider: ProviderDoc, apiKey: string | null): Promise<RemoteModel[]> {
  const nativeGemini = provider.id === "gemini"
  const anthropic = provider.id === "anthropic"
  let base = provider.base_url?.replace(/\/+$/, "")
  if (nativeGemini) base ||= "https://generativelanguage.googleapis.com/v1beta"
  if (!base) throw new Error(`${provider.id}: base_url no configurada`)
  if (anthropic && !/\/v1$/.test(base)) base += "/v1"
  const headers: Record<string, string> = {}
  if (apiKey) {
    if (anthropic) headers["x-api-key"] = apiKey
    else if (nativeGemini) headers["x-goog-api-key"] = apiKey
    else headers.Authorization = `Bearer ${apiKey}`
  }
  if (anthropic) headers["anthropic-version"] = "2023-06-01"
  const models: RemoteModel[] = []
  let cursor = ""
  const seenCursors = new Set<string>()
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${base}/models`)
    if (nativeGemini) { url.searchParams.set("pageSize", "1000"); if (cursor) url.searchParams.set("pageToken", cursor) }
    else if (anthropic) { url.searchParams.set("limit", "1000"); if (cursor) url.searchParams.set("after_id", cursor) }
    else if (cursor) url.searchParams.set("after", cursor)
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(10000), redirect: "error" })
    if (!res.ok) throw new Error(`${provider.id}: catálogo respondió HTTP ${res.status}`)
    const data = await res.json() as any
    const rows = nativeGemini ? data.models : data.data
    if (!Array.isArray(rows)) throw new Error(`${provider.id}: catálogo inválido`)
    for (const row of rows) {
      const id = nativeGemini ? row.name?.replace(/^models\//, "") : row.id
      if (typeof id !== "string" || !id.trim()) throw new Error(`${provider.id}: modelo sin identificador válido`)
      let type: ModelDoc["model_type"] | undefined
      const methods = row.supportedGenerationMethods
      if (nativeGemini && Array.isArray(methods) && !methods.includes("generateContent")) {
        type = methods.some((method: string) => /embed/i.test(method)) ? "embedding" : "vision"
      } else if (/^(text-embedding-|embed-|embedding)/i.test(id)) type = "embedding"
      else if (/^(whisper|.*transcribe)/i.test(id)) type = "stt"
      else if (/^(tts-|.*-tts)/i.test(id)) type = "tts"
      else if (/^(dall-e|gpt-image|imagen-)/i.test(id)) type = "vision"
      const context = row.inputTokenLimit ?? row.context_length ?? row.context_window
      models.push({ id, name: row.displayName ?? row.display_name ?? row.name, type,
        context: typeof context === "number" && context > 0 ? context : undefined })
    }
    const next = nativeGemini ? data.nextPageToken : data.has_more ? data.last_id ?? rows.at(-1)?.id : data.next_cursor
    if (!next && data.has_more) throw new Error(`${provider.id}: paginación incompleta`)
    if (!next) {
      if (!models.length) throw new Error(`${provider.id}: catálogo vacío; se conserva el anterior`)
      return [...new Map(models.map(model => [model.id, model])).values()]
    }
    if (typeof next !== "string" || seenCursors.has(next)) throw new Error(`${provider.id}: cursor de catálogo inválido`)
    seenCursors.add(next)
    cursor = next
  }
  throw new Error(`${provider.id}: catálogo excede el límite de páginas`)
}

export async function reconcileProviderModels(provider: ProviderDoc, remote: RemoteModel[], now = Date.now()): Promise<SyncResult> {
  if (!remote.length) throw new Error("No se reconcilia un catálogo vacío")
  await ensureIndexes([["models", "provider_id"]])
  const models = await col<ModelDoc>("models")
  const existing = await models.findBy("provider_id", provider.id)
  const wireId = (doc: ModelDoc) => doc.catalog_wire_id ?? (doc.id.startsWith(`${provider.id}/`) && provider.id !== "nvidia" ? doc.id.slice(provider.id.length + 1) : doc.id)
  const byWire = new Map(existing.map(row => [wireId(row.doc), row]))
  const ids = new Set(remote.map(model => model.id))
  const slot = latestCatalogSlot(now)
  // Determine keys before writing; never overwrite another provider's model.
  const planned = []
  for (const model of remote) {
    const row = byWire.get(model.id)
    let key = row?.id ?? model.id
    if (!row && (provider.id === "opencode-go" || provider.id === "hivecode-free")) key = `${provider.id}/${model.id}`
    let conflict = await models.get(key)
    if (conflict && conflict.doc.provider_id !== provider.id) {
      if (["nvidia", "anthropic", "gemini"].includes(provider.id)) throw new Error(`${provider.id}: colisión de modelo ${model.id}`)
      key = `${provider.id}/${model.id}`
      conflict = await models.get(key)
      if (conflict && conflict.doc.provider_id !== provider.id) throw new Error(`${provider.id}: colisión de catálogo`)
    }
    planned.push({ model, key })
  }
  for (const { model, key } of planned) {
    const current = await models.get(key)
    const old = current?.doc
    const returning = old?.deprecated_at != null
    const doc: ModelDoc = {
      ...old, id: key, provider_id: provider.id, name: old?.name ?? model.name ?? model.id,
      model_type: old?.model_type ?? model.type ?? "llm",
      context_window: old?.context_window ?? model.context ?? 32768,
      capabilities: old?.capabilities ?? null,
      // New/returning models require selection; never undo a manual disable.
      enabled: returning ? old?.catalog_enabled_before_deprecation ?? true : old?.enabled ?? true,
      active: returning ? false : old?.active ?? false,
      catalog_managed: true, catalog_wire_id: model.id, catalog_last_seen_at: now,
      deprecated_at: null,
    }
    delete doc.catalog_missing_since_slot
    delete doc.catalog_enabled_before_deprecation
    await models.put(key, doc, { expectedVersion: current?.version ?? 0 })
  }
  let deprecated = 0
  for (const row of existing) {
    if (ids.has(wireId(row.doc))) continue
    const current = await models.get(row.id)
    if (!current) continue
    const missing = current.doc.catalog_missing_since_slot ?? slot
    const retire = slot > missing
    await models.put(row.id, {
      ...current.doc, catalog_managed: true, catalog_missing_since_slot: missing,
      ...(retire ? { active: false, enabled: false, deprecated_at: current.doc.deprecated_at ?? now,
        catalog_enabled_before_deprecation: current.doc.catalog_enabled_before_deprecation ?? current.doc.enabled } : {}),
    }, { expectedVersion: current.version })
    if (retire && !current.doc.deprecated_at) deprecated++
  }
  return { synced: remote.length, deprecated }
}

export function syncProviderCatalog(provider: ProviderDoc, now = Date.now()): Promise<SyncResult> {
  const pending = locks.get(provider.id)
  if (pending) return pending
  const work = (async () => {
    if (provider.id === "hiveagents") return { synced: 1, deprecated: 0, skipped: `Modelo fijo ${HIVEAGENTS_MODEL_ID}` }
    const state = await readState(provider.id)
    await saveState(provider.id, { ...state, attempted_at: now })
    try {
      const key = await getProviderApiKey(provider.id)
      const remote = await discoverProviderModels(provider, key)
      const result = await reconcileProviderModels(provider, remote, now)
      await saveState(provider.id, { completed_slot: latestCatalogSlot(now), attempted_at: now, succeeded_at: now, ...result })
      log.info(`${provider.id}: ${result.synced} modelos, ${result.deprecated} deprecados`)
      return result
    } catch (error) {
      // Persist sanitized diagnostics: never store URLs, response bodies or keys.
      const message = (error as Error).message
      const safe = message.startsWith(`${provider.id}:`) ? message : `${provider.id}: fallo de consulta o persistencia`
      await saveState(provider.id, { ...state, attempted_at: now, error: safe })
      throw new Error(safe)
    }
  })().finally(() => locks.delete(provider.id))
  locks.set(provider.id, work)
  return work
}

export async function runDueProviderCatalogSync(now = Date.now()): Promise<void> {
  const config = await (await col<CodeConfigDoc>("codeConfig")).scan()
  const selected = new Set(config.filter(row => row.doc.key === "default_provider" && row.doc.value).map(row => row.doc.value))
  const providers = await (await col<ProviderDoc>("providers")).scan()
  for (const row of providers) {
    const provider = row.doc
    if (provider.category !== "llm" || (!provider.active && !selected.has(provider.id)) || !provider.enabled || provider.id === "hiveagents") continue
    const state = await readState(provider.id)
    if ((state.completed_slot ?? 0) >= latestCatalogSlot(now)) continue
    if (state.attempted_at && now - state.attempted_at < RETRY) continue
    try { await syncProviderCatalog(provider, now) }
    catch (error) { log.warn((error as Error).message) }
  }
}

/** First boot/catch-up in background, then check the persisted weekly slot each minute. */
export function startProviderCatalogScheduler(): () => Promise<void> {
  let running: Promise<void> | undefined
  let stopped = false
  const tick = () => {
    if (stopped || running) return
    running = runDueProviderCatalogSync().catch(() => log.warn("No se pudo ejecutar la sincronización del catálogo"))
      .finally(() => { running = undefined })
  }
  const timer = setInterval(tick, 60_000)
  timer.unref()
  tick()
  log.info("Catálogo: domingos 02:00 America/Bogota; recuperación al arrancar")
  return async () => { stopped = true; clearInterval(timer); await running }
}
