import { maskApiKey, storeProviderApiKey, getProviderApiKey, hasProviderApiKey } from "../../storage/crypto"
import { col } from "../../storage/hive"
import type { ModelDoc, ProviderDoc } from "../../storage/collections"
import { getHiveAgentsModelStatusFromDb, loadHiveAgentsModelFromDb } from "../../agent/llm-providers/hiveagents-loader"
import {
  HIVEAGENTS_DEFAULT_LOAD_CTX,
  HIVEAGENTS_MODEL_ID,
  HIVEAGENTS_OPENAI_BASE_URL,
} from "../../agent/llm-providers/hiveagents"
import { logger } from "../../utils/logger"

const log = logger.child("gateway")
const SUPPORTED_LLM_PROVIDERS = new Set(["hiveagents", "openai", "anthropic", "gemini", "mistral", "deepseek", "kimi", "openrouter", "groq", "qwen", "nvidia", "codex", "opencode-go", "minimax", "hivecode-free"])

export async function handleGetProviders(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const rawProviders = (await (await col<ProviderDoc>("providers")).scan())
    .map((entry) => entry.doc)
    .filter((provider) => SUPPORTED_LLM_PROVIDERS.has(provider.id))
  const modelsRows = (await (await col<ModelDoc>("models")).scan()).map((entry) => entry.doc)

  const modelsByProvider: Record<string, ModelDoc[]> = {}
  for (const model of modelsRows) {
    if (!modelsByProvider[model.provider_id]) modelsByProvider[model.provider_id] = []
    modelsByProvider[model.provider_id].push(model)
  }

  const providers = await Promise.all(rawProviders.map(async (p) => {
    const has_api_key = await hasProviderApiKey(p.id)
    let masked_api_key: string | null = null
    if (has_api_key) {
      try {
        const plain = await getProviderApiKey(p.id)
        if (plain) masked_api_key = maskApiKey(plain)
      } catch { /* silently ignore */ }
    }
    return {
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      enabled: p.enabled,
      active: p.active,
      num_ctx: p.num_ctx ?? null,
      has_api_key: has_api_key ? 1 : 0,
      has_headers: 0,
      masked_api_key,
      models: modelsByProvider[p.id] || [],
    }
  }))

  return addCorsHeaders(Response.json({ providers }), req)
}

export async function handleCreateProvider(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const id = body.id
  if (!id) return addCorsHeaders(Response.json({ ok: false, error: "id is required" }, { status: 400 }), req)

  const providers = await col<ProviderDoc>("providers")
  const existing = await providers.get(id)
  const provider: ProviderDoc = {
    id,
    name: body.name || id,
    base_url: id === "hiveagents"
      ? HIVEAGENTS_OPENAI_BASE_URL
      : body.base_url || body.baseUrl || null,
    category: "llm",
    num_ctx: id === "hiveagents"
      ? HIVEAGENTS_DEFAULT_LOAD_CTX
      : body.num_ctx !== undefined ? Number(body.num_ctx) : null,
    num_gpu: Number(body.num_gpu ?? 0),
    enabled: body.enabled !== undefined ? !!body.enabled : true,
    active: body.active !== undefined ? !!body.active : true,
    is_free_tier: !!body.is_free_tier,
    created_at: existing?.doc.created_at ?? Date.now(),
  }
  await providers.put(id, provider, { expectedVersion: existing?.version ?? 0 })
  if (id === "hiveagents" && (body.config?.apiKey || body.apiKey)) {
    await storeProviderApiKey(id, body.config?.apiKey || body.apiKey)
    const ready = await loadHiveAgentsModelFromDb(HIVEAGENTS_MODEL_ID)
    if (!ready.success) {
      return addCorsHeaders(Response.json({ ok: false, error: ready.error }, { status: 502 }), req)
    }
  }
  return addCorsHeaders(Response.json({ ok: true, provider }), req)
}

export async function handleToggleProvider(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const providerId = url.pathname.split("/")[3]
  const body = await req.json().catch(() => ({}))
  const { active } = body

  if (active === undefined) {
    return addCorsHeaders(new Response("Missing active field", { status: 400 }), req)
  }

  await updateProvider(providerId, { active: !!active, enabled: !!active })
  await cascadeProviderModels(providerId, !!active)
  return addCorsHeaders(Response.json({ success: true, active }), req)
}

export async function handleUpdateProvider(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const providerIdMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/)
  if (!providerIdMatch) {
    return addCorsHeaders(new Response("Invalid path", { status: 400 }), req)
  }

  const id = providerIdMatch[1]
  const body = await req.json().catch(() => ({}))
  const patch: Partial<ProviderDoc> = {}

  if (id === "hiveagents") {
    if (body.config?.apiKey || body.apiKey) {
      await storeProviderApiKey(id, body.config?.apiKey || body.apiKey)
    }
    await updateProvider(id, {
      base_url: HIVEAGENTS_OPENAI_BASE_URL,
      num_ctx: HIVEAGENTS_DEFAULT_LOAD_CTX,
      enabled: true,
    })
    const ready = await loadHiveAgentsModelFromDb(HIVEAGENTS_MODEL_ID)
    if (!ready.success) {
      return addCorsHeaders(Response.json({ ok: false, error: ready.error }, { status: 502 }), req)
    }
    return addCorsHeaders(Response.json({
      ok: true,
      ready: true,
      model: HIVEAGENTS_MODEL_ID,
      base_url: HIVEAGENTS_OPENAI_BASE_URL,
    }), req)
  }

  if (body.name) patch.name = body.name
  const baseUrl = body.base_url !== undefined ? body.base_url : body.baseUrl
  if (baseUrl !== undefined) patch.base_url = baseUrl || null
  if (body.enabled !== undefined) patch.enabled = !!body.enabled
  if (body.active !== undefined) patch.active = !!body.active
  const numCtx = body.num_ctx !== undefined ? body.num_ctx : body.numCtx
  if (numCtx !== undefined) patch.num_ctx = numCtx ? Number(numCtx) : null
  if (body.config?.apiKey || body.apiKey) {
    await storeProviderApiKey(id, body.config?.apiKey || body.apiKey)
  }

  if (Object.keys(patch).length > 0) {
    await updateProvider(id, patch)
    if (patch.active !== undefined) await cascadeProviderModels(id, patch.active)
    else if (patch.enabled !== undefined) await cascadeProviderModels(id, patch.enabled)
  }

  return addCorsHeaders(Response.json({ ok: true }), req)
}

export async function handleSyncProviderModels(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  providerId: string
): Promise<Response> {
  const providerRow = (await (await col<ProviderDoc>("providers")).get(providerId))?.doc
  if (!providerRow) {
    return addCorsHeaders(new Response("Provider not found", { status: 404 }), req)
  }
  if (!providerRow.base_url) {
    return addCorsHeaders(Response.json({ error: "Provider base_url is required to sync models" }, { status: 400 }), req)
  }

  if (providerId === "hiveagents") {
    const models = (await (await col<ModelDoc>("models")).findBy("provider_id", providerId))
      .map((entry) => entry.doc)
      .filter((model) => model.id === HIVEAGENTS_MODEL_ID)
    return addCorsHeaders(Response.json({ success: true, synced: models.length, models }), req)
  }

  const baseUrl = providerRow.base_url.replace(/\/(v1|api)\/?$/, "")

  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      return addCorsHeaders(Response.json({ error: `${providerId} responded ${res.status}` }, { status: 502 }), req)
    }
    const data = await res.json() as { data: Array<{ id: string }> }
    const modelNames = providerId === "hiveagents"
      ? (data.data || []).map(m => m.id).filter(id => id === HIVEAGENTS_MODEL_ID)
      : (data.data || []).map(m => m.id)

    if (modelNames.length === 0) {
      return addCorsHeaders(Response.json({ error: "No models found from provider" }, { status: 400 }), req)
    }

    const modelsCol = await col<ModelDoc>("models")
    for (const name of modelNames) {
      const existing = await modelsCol.get(name)
      await modelsCol.put(name, {
        id: name,
        provider_id: providerId,
        name,
        model_type: "llm",
        context_window: existing?.doc.context_window ?? 32768,
        capabilities: existing?.doc.capabilities ?? null,
        enabled: true,
        active: true,
      }, { expectedVersion: existing?.version ?? 0 })
    }

    for (const entry of await modelsCol.findBy("provider_id", providerId)) {
      if (!modelNames.includes(entry.doc.id)) {
        await modelsCol.put(entry.id, { ...entry.doc, active: false, enabled: false }, { expectedVersion: entry.version })
      }
    }

    const models = (await modelsCol.findBy("provider_id", providerId)).map((entry) => entry.doc)
    return addCorsHeaders(Response.json({ success: true, synced: modelNames.length, models }), req)
  } catch (err: unknown) {
    const errorMsg = (err as Error).message
    return addCorsHeaders(Response.json({ error: `Could not connect to provider: ${errorMsg}` }, { status: 502 }), req)
  }
}

export async function handleLoadHiveAgentsModel(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response
): Promise<Response> {
  const modelId = HIVEAGENTS_MODEL_ID

  const result = await loadHiveAgentsModelFromDb(modelId)
  if (!result.success) {
    log.error(`[gateway] Failed to load hiveagents model ${modelId}: ${result.error}`)
    return addCorsHeaders(Response.json({ error: result.error, model_id: modelId, ctx: result.ctx }, { status: 502 }), req)
  }

  const loading = result.loading === true
  log.info(`[gateway] hiveagents load request accepted for ${modelId} with ctx=${result.ctx}${loading ? " (backend still loading)" : ""}`)
  return addCorsHeaders(Response.json({ success: true, loading, model_id: modelId, ctx: result.ctx }), req)
}

export async function handleGetHiveAgentsModelStatus(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response
): Promise<Response> {
  const status = await getHiveAgentsModelStatusFromDb()
  return addCorsHeaders(Response.json(status), req)
}

async function updateProvider(id: string, patch: Partial<ProviderDoc>): Promise<void> {
  const providers = await col<ProviderDoc>("providers")
  const existing = await providers.get(id)
  if (!existing) return
  await providers.put(id, { ...existing.doc, ...patch }, { expectedVersion: existing.version })
}

async function cascadeProviderModels(providerId: string, active: boolean): Promise<void> {
  const models = await col<ModelDoc>("models")
  for (const entry of await models.findBy("provider_id", providerId)) {
    await models.put(entry.id, { ...entry.doc, active, enabled: active }, { expectedVersion: entry.version })
  }
}
