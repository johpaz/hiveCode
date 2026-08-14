import { col } from "../../storage/hive"
import type { AgentDoc, UserDoc } from "../../storage/collections"
import { maybeLoadHiveAgentsModelFromDb } from "../../agent/llm-providers/hiveagents-loader"
import { HIVEAGENTS_MODEL_ID } from "../../agent/llm-providers/hiveagents"
import { logger } from "../../utils/logger"

const log = logger.child("gateway:agents")

async function triggerHiveAgentsPreload(providerId: unknown, modelId: unknown): Promise<void> {
  if (providerId !== "hiveagents" || !modelId || typeof modelId !== "string") return

  const result = await maybeLoadHiveAgentsModelFromDb("hiveagents", modelId)
  if (!result.success) {
    throw new Error(`HiveAgents preload failed for ${modelId}: ${result.error}`)
  }
  log.info(`[hiveagents] ${modelId} loaded and ready with ctx=${result.ctx}`)
}

export async function handleGetAgents(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const typeFilter = url.searchParams.get("type")
  const rows = (await (await col<AgentDoc>("agents")).scan())
    .map((entry) => entry.doc)
    .filter((agent) => !agent.id.startsWith("hl-"))
    .filter((agent) => !typeFilter || typeFilter === "hivelearn" || agent.status === typeFilter)
    .sort((a, b) => b.created_at - a.created_at)

  const agents = rows.map(agent => ({
    id: agent.id,
    userId: agent.user_id,
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.system_prompt,
    tone: agent.tone,
    role: agent.role as "coordinator" | "worker",
    status: agent.status,
    enabled: Boolean(agent.enabled),
    providerId: agent.provider_id,
    modelId: agent.model_id,
    toolsJson: agent.tools_json,
    skillsJson: agent.skills_json,
    parentId: agent.parent_id,
    maxIterations: agent.max_iterations,
    workspace: agent.workspace,
    hasHeaders: false,
    createdAt: new Date(agent.created_at).toISOString(),
    updatedAt: new Date(agent.updated_at).toISOString(),
    taskCount: 0,
    successRate: 100,
  }))

  return addCorsHeaders(Response.json({ agents }), req)
}

export async function handleCreateAgent(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const agentId = body.id || crypto.randomUUID().replace(/-/g, "").slice(0, 16)
  const providerId = body.providerId || body.provider_id || "hiveagents"
  const modelId = providerId === "hiveagents"
    ? HIVEAGENTS_MODEL_ID
    : body.modelId || body.model_id || "qwen3-coder"
  const now = Date.now()

  const agent: AgentDoc = {
    id: agentId,
    user_id: body.userId || body.user_id || "default-user",
    name: body.name || agentId,
    description: body.description || "",
    system_prompt: body.systemPrompt || body.system_prompt || null,
    tone: body.tone || "friendly",
    role: body.role || "worker",
    status: body.status || "idle",
    enabled: body.enabled !== undefined ? !!body.enabled : true,
    provider_id: providerId,
    model_id: modelId,
    tools_json: body.toolsJson ? JSON.stringify(body.toolsJson) : body.tools_json ?? null,
    skills_json: body.skillsJson ? JSON.stringify(body.skillsJson) : body.skills_json ?? null,
    parent_id: body.parentId || body.parent_id || "root",
    max_iterations: Number(body.maxIterations || body.max_iterations || 10),
    workspace: body.workspace || null,
    created_at: now,
    updated_at: now,
  }

  await (await col<AgentDoc>("agents")).put(agentId, agent)
  await triggerHiveAgentsPreload(agent.provider_id, agent.model_id)

  return addCorsHeaders(Response.json({
    ok: true,
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      providerId: agent.provider_id,
      modelId: agent.model_id,
      tone: agent.tone,
      status: agent.status,
      enabled: agent.enabled,
      active: agent.enabled,
      createdAt: new Date(agent.created_at).toISOString(),
      workspace: agent.workspace,
    }
  }), req)
}

export async function handleUpdateAgent(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.pathname.split("/").pop()

  if (!agentId) {
    return addCorsHeaders(new Response("Missing ID", { status: 400 }), req)
  }

  const agents = await col<AgentDoc>("agents")
  const existing = await agents.get(agentId)
  if (!existing) return addCorsHeaders(Response.json({ ok: false, error: "Agent not found" }, { status: 404 }), req)

  const body = await req.json().catch(() => ({}))
  const patch: Partial<AgentDoc> = {}
  const map: Record<keyof AgentDoc, string[]> = {
    id: [],
    user_id: ["user_id", "userId"],
    name: ["name"],
    description: ["description"],
    system_prompt: ["system_prompt", "systemPrompt"],
    tone: ["tone"],
    role: ["role"],
    agent_type: [],
    status: ["status"],
    enabled: ["enabled"],
    provider_id: ["provider_id", "providerId"],
    model_id: ["model_id", "modelId"],
    fallback_provider_id: ["fallback_provider_id", "fallbackProviderId"],
    fallback_model_id: ["fallback_model_id", "fallbackModelId"],
    effort: ["effort"],
    max_input_tokens: ["max_input_tokens", "maxInputTokens"],
    max_output_tokens: ["max_output_tokens", "maxOutputTokens"],
    max_cost_usd: ["max_cost_usd", "maxCostUsd"],
    tools_json: ["tools_json", "toolsJson"],
    skills_json: ["skills_json", "skillsJson"],
    permission_profile: [],
    user_instructions: ["user_instructions", "userInstructions"],
    config_version: [],
    parent_id: ["parent_id", "parentId"],
    max_iterations: ["max_iterations", "maxIterations"],
    workspace: ["workspace"],
    lastTraceAt: ["lastTraceAt"],
    created_at: [],
    updated_at: [],
  }

  for (const [field, keys] of Object.entries(map) as Array<[keyof AgentDoc, string[]]>) {
    for (const key of keys) {
      if (body[key] !== undefined) {
        ;(patch as any)[field] = typeof body[key] === "object" ? JSON.stringify(body[key]) : body[key]
        break
      }
    }
  }
  if (existing.doc.agent_type) {
    // Core identity, prompt, permissions and capability lists are product
    // contracts. Only operational/user settings may be customized.
    const allowed = new Set<keyof AgentDoc>([
      "provider_id", "model_id", "fallback_provider_id", "fallback_model_id",
      "effort", "max_input_tokens", "max_output_tokens", "max_cost_usd",
      "max_iterations", "user_instructions", "workspace", "enabled",
    ])
    for (const field of Object.keys(patch) as Array<keyof AgentDoc>) {
      if (!allowed.has(field)) delete patch[field]
    }
    patch.config_version = (existing.doc.config_version ?? 0) + 1
  }
  if (patch.enabled !== undefined) patch.enabled = !!patch.enabled
  if (patch.max_iterations !== undefined) patch.max_iterations = Number(patch.max_iterations)
  if (patch.max_input_tokens !== undefined) patch.max_input_tokens = Number(patch.max_input_tokens)
  if (patch.max_output_tokens !== undefined) patch.max_output_tokens = Number(patch.max_output_tokens)
  if (patch.max_cost_usd !== undefined) patch.max_cost_usd = Number(patch.max_cost_usd)
  const effectiveProvider = patch.provider_id ?? existing.doc.provider_id
  if (effectiveProvider === "hiveagents") patch.model_id = HIVEAGENTS_MODEL_ID

  const userPreferences = body.userPreferences !== undefined ? body.userPreferences : body.user_preferences
  if (userPreferences !== undefined && existing.doc.user_id) {
    const users = await col<UserDoc>("users")
    const user = await users.get(existing.doc.user_id)
    if (user) {
      await users.put(existing.doc.user_id, { ...user.doc, notes: String(userPreferences) }, { expectedVersion: user.version })
    }
  }

  const updated = { ...existing.doc, ...patch, updated_at: Date.now() }
  await agents.put(agentId, updated, { expectedVersion: existing.version })

  if (patch.provider_id !== undefined || patch.model_id !== undefined) {
    await triggerHiveAgentsPreload(updated.provider_id, updated.model_id)
  }

  return addCorsHeaders(Response.json({ ok: true }), req)
}

export async function handleDeleteAgent(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.pathname.split("/").pop()

  if (!agentId) {
    return addCorsHeaders(new Response("Missing ID", { status: 400 }), req)
  }

  await (await col<AgentDoc>("agents")).delete(agentId)
  return addCorsHeaders(Response.json({ ok: true }), req)
}
