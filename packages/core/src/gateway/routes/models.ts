import type { Config } from "../../config/loader.ts"
import { col } from "../../storage/hive.ts"
import type { AgentDoc, ModelDoc } from "../../storage/collections.ts"
import { HIVEAGENTS_MODEL_ID } from "../../agent/llm-providers/hiveagents"

export async function handleGetModels(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const providerId = url.searchParams.get("provider_id")
  const modelsCol = await col<ModelDoc>("models")
  const models = providerId
    ? (await modelsCol.findBy("provider_id", providerId)).map((entry) => entry.doc)
    : (await modelsCol.scan()).map((entry) => entry.doc)

  models.sort((a, b) => a.name.localeCompare(b.name))
  return addCorsHeaders(Response.json({ models }), req)
}

export async function handleCreateModel(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const providerId = body.provider_id || body.providerId
  const name = body.name
  const modelType = body.model_type || body.modelType || "llm"
  const contextWindow = Number(body.context_window || body.contextWindow || 50000)

  if (!name || !providerId) {
    return addCorsHeaders(Response.json({ ok: false, error: "name and provider_id are required" }, { status: 400 }), req)
  }

  if (providerId === "hiveagents" && (body.id || name) !== HIVEAGENTS_MODEL_ID) {
    return addCorsHeaders(Response.json({
      ok: false,
      error: `HiveAgents only supports ${HIVEAGENTS_MODEL_ID}`,
    }, { status: 400 }), req)
  }

  const id = body.id || name
  const models = await col<ModelDoc>("models")
  const existing = await models.get(id)
  if (existing) {
    return addCorsHeaders(Response.json({ ok: false, error: "Model already exists", id, model: existing.doc }, { status: 409 }), req)
  }

  const model: ModelDoc = {
    id,
    name,
    provider_id: providerId,
    model_type: modelType,
    context_window: contextWindow,
    capabilities: body.capabilities ?? null,
    enabled: true,
    active: true,
  }
  await models.put(id, model)
  return addCorsHeaders(Response.json({ ok: true, id, model }, { status: 201 }), req)
}

export async function handleToggleModel(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const pathMatch = url.pathname.match(/^\/api\/models\/([^/]+)\/toggle$/)
  const modelId = pathMatch ? decodeURIComponent(pathMatch[1]) : null
  const body = await req.json().catch(() => ({}))
  const { active } = body

  if (!modelId || active === undefined) {
    return addCorsHeaders(Response.json({ success: false, error: "model id and active required" }), req)
  }

  const models = await col<ModelDoc>("models")
  const existing = await models.get(modelId)
  if (existing) {
    if (existing.doc.provider_id === "hiveagents") {
      return addCorsHeaders(Response.json({
        success: false,
        error: "The HiveAgents model preset cannot be disabled",
      }, { status: 400 }), req)
    }
    await models.put(modelId, { ...existing.doc, active: !!active, enabled: !!active }, { expectedVersion: existing.version })
  }

  return addCorsHeaders(Response.json({ success: true, active }), req)
}

export async function handleGetModelsConfig(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  config: Config
): Promise<Response> {
  return addCorsHeaders(Response.json({
    config: config.models || {},
    availableProviders: ["hiveagents", "openai", "anthropic", "gemini", "kimi", "openrouter", "deepseek"],
  }), req)
}

export async function handleDeleteModel(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const pathMatch = url.pathname.match(/^\/api\/models\/([^/]+)$/)
  const modelId = pathMatch ? decodeURIComponent(pathMatch[1]) : null

  if (!modelId) {
    return addCorsHeaders(Response.json({ ok: false, error: "model id required" }, { status: 400 }), req)
  }

  const models = await col<ModelDoc>("models")
  const existing = await models.get(modelId)
  if (!existing) {
    return addCorsHeaders(Response.json({ ok: false, error: "Model not found" }, { status: 404 }), req)
  }
  if (existing.doc.provider_id === "hiveagents") {
    return addCorsHeaders(Response.json({
      ok: false,
      error: "The HiveAgents model preset cannot be deleted",
    }, { status: 400 }), req)
  }

  const agents = (await (await col<AgentDoc>("agents")).findBy("model_id", modelId)).map((entry) => entry.doc)
  if (agents.length > 0) {
    const names = agents.map(a => a.name).join(", ")
    return addCorsHeaders(Response.json({ ok: false, error: `En uso por agentes: ${names}` }, { status: 409 }), req)
  }

  await models.delete(modelId)
  return addCorsHeaders(Response.json({ ok: true }), req)
}

export async function handleUpdateModel(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const pathMatch = url.pathname.match(/^\/api\/models\/([^/]+)$/)
  const oldId = pathMatch ? decodeURIComponent(pathMatch[1]) : null

  if (!oldId) {
    return addCorsHeaders(Response.json({ ok: false, error: "model id required" }, { status: 400 }), req)
  }

  const models = await col<ModelDoc>("models")
  const existing = await models.get(oldId)
  if (!existing) {
    return addCorsHeaders(Response.json({ ok: false, error: "Model not found" }, { status: 404 }), req)
  }

  if (existing.doc.provider_id === "hiveagents" && oldId === HIVEAGENTS_MODEL_ID) {
    return addCorsHeaders(Response.json({
      ok: false,
      error: "The HiveAgents model preset is immutable",
    }, { status: 400 }), req)
  }

  const body = await req.json().catch(() => ({}))
  const newId: string | undefined = body.id
  const newName: string | undefined = body.name

  if (!newId || newId === oldId) {
    const model = { ...existing.doc, name: newName || existing.doc.name }
    await models.put(oldId, model, { expectedVersion: existing.version })
    return addCorsHeaders(Response.json({ ok: true, model }), req)
  }

  if (await models.get(newId)) {
    return addCorsHeaders(Response.json({ ok: false, error: "Ya existe un modelo con ese ID" }, { status: 409 }), req)
  }

  const model: ModelDoc = { ...existing.doc, id: newId, name: newName || existing.doc.name }
  await models.put(newId, model)
  const agents = await col<AgentDoc>("agents")
  for (const entry of await agents.findBy("model_id", oldId)) {
    await agents.put(entry.id, { ...entry.doc, model_id: newId, updated_at: Date.now() }, { expectedVersion: entry.version })
  }
  await models.delete(oldId)

  return addCorsHeaders(Response.json({ ok: true, model }), req)
}

export async function handleUpdateModelsConfig(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  config: Config,
  agent?: any
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { defaultProvider, defaults, providers } = body

  config.models = config.models || {}
  if (defaultProvider) config.models.defaultProvider = defaultProvider
  if (defaults) config.models.defaults = { ...(config.models.defaults || {}), ...defaults }
  if (providers) config.models.providers = { ...(config.models.providers || {}), ...providers }

  if (agent) {
    await agent.updateConfig(config)
  }

  return addCorsHeaders(Response.json({ success: true }), req)
}
