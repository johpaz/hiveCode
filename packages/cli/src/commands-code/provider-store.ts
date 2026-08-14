import { col, toIndexable } from "@johpaz/hivecode-core/storage/hive"
import type {
  AgentDoc,
  CodeConfigDoc,
  CodeSessionDoc,
  CodeTaskDoc,
  CodeTraceDoc,
  ModelDoc,
  ProviderDoc,
} from "@johpaz/hivecode-core/storage/collections"
import {
  HIVEAGENTS_MODEL_ID,
  HIVEAGENTS_OPENAI_BASE_URL,
} from "@johpaz/hivecode-core/agent/hiveagents-loader"

export interface ProviderSummary {
  id: string
  name: string
  base_url: string | null
  enabled: boolean
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id)
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name)
}

export async function listProviders(): Promise<ProviderSummary[]> {
  const providers = await col<ProviderDoc>("providers")
  const rows = await providers.scan()
  return rows
    .map((entry) => entry.doc)
    .sort(byId)
    .map((doc) => ({
      id: doc.id,
      name: doc.name,
      base_url: doc.base_url,
      enabled: doc.enabled,
    }))
}

export async function listProviderIds(): Promise<string[]> {
  return (await listProviders()).map((provider) => provider.id)
}

export async function getProvider(providerId: string): Promise<ProviderDoc | null> {
  return (await (await col<ProviderDoc>("providers")).get(providerId))?.doc ?? null
}

export async function upsertProvider(
  providerId: string,
  patch: { name?: string; baseUrl?: string | null; enabled?: boolean; active?: boolean }
): Promise<void> {
  const providers = await col<ProviderDoc>("providers")
  const existing = await providers.get(providerId)
  const isHiveAgents = providerId === "hiveagents"
  const doc: ProviderDoc = {
    id: providerId,
    name: patch.name ?? existing?.doc.name ?? providerId,
    base_url: isHiveAgents
      ? HIVEAGENTS_OPENAI_BASE_URL
      : patch.baseUrl ?? existing?.doc.base_url ?? null,
    category: existing?.doc.category ?? "llm",
    num_ctx: existing?.doc.num_ctx ?? null,
    num_gpu: existing?.doc.num_gpu ?? -1,
    enabled: patch.enabled ?? existing?.doc.enabled ?? true,
    active: patch.active ?? existing?.doc.active ?? false,
    is_free_tier: existing?.doc.is_free_tier ?? false,
    created_at: existing?.doc.created_at ?? Date.now(),
  }
  await providers.put(providerId, doc, { expectedVersion: existing?.version ?? 0 })
}

export async function deleteProvider(providerId: string): Promise<void> {
  const providers = await col<ProviderDoc>("providers")
  await providers.delete(providerId)
}

export async function getCodeConfig(key: string): Promise<string> {
  const codeConfig = await col<CodeConfigDoc>("codeConfig")
  return (await codeConfig.get(key))?.doc.value ?? ""
}

export async function setCodeConfig(key: string, value: string | null): Promise<void> {
  const codeConfig = await col<CodeConfigDoc>("codeConfig")
  const existing = await codeConfig.get(key)
  await codeConfig.put(key, { key, value, updated_at: Date.now() }, { expectedVersion: existing?.version ?? 0 })
}

export async function getDefaultProvider(): Promise<string> {
  return getCodeConfig("default_provider")
}

export async function setDefaultProvider(providerId: string): Promise<void> {
  await setCodeConfig("default_provider", providerId)
}

export async function getProviderModel(providerId: string): Promise<string> {
  return getCodeConfig(`provider_model_${providerId}`)
}

export async function setProviderModel(providerId: string, modelId: string): Promise<void> {
  await setCodeConfig(
    `provider_model_${providerId}`,
    providerId === "hiveagents" ? HIVEAGENTS_MODEL_ID : modelId,
  )
}

export async function getAllProviderModels(): Promise<Map<string, string>> {
  const codeConfig = await col<CodeConfigDoc>("codeConfig")
  const rows = await codeConfig.scan()
  return new Map(
    rows
      .map((entry) => entry.doc)
      .filter((doc) => doc.key.startsWith("provider_model_") && doc.value)
      .map((doc) => [doc.key.replace("provider_model_", ""), doc.value ?? ""])
  )
}

export async function listModelChoices(providerId: string): Promise<{ value: string; label: string }[]> {
  const models = await col<ModelDoc>("models")
  const rows = await models.findBy("provider_id", providerId)
  return rows
    .map((entry) => entry.doc)
    .filter((model) => model.model_type === "llm" && model.enabled)
    .sort(byName)
    .map((model) => ({ value: model.id, label: model.name }))
}

export async function listFreeProviderModels(providerId: string): Promise<Array<{
  id: string
  name: string
  context: number
  capabilities: string
}>> {
  const models = await col<ModelDoc>("models")
  const rows = await models.findBy("provider_id", providerId)
  return rows
    .map((entry) => entry.doc)
    .filter((model) => model.model_type === "llm" && model.enabled)
    .sort(byName)
    .map((model) => ({
      id: model.id,
      name: model.name,
      context: model.context_window,
      capabilities: (() => {
        try { return (JSON.parse(model.capabilities ?? "[]") as string[]).join(", ") } catch { return "" }
      })(),
    }))
}

export async function modelExists(modelId: string): Promise<boolean> {
  return Boolean(await (await col<ModelDoc>("models")).get(modelId))
}

export async function setCoordinatorProviderModel(providerId: string, modelId: string | null): Promise<void> {
  const agents = await col<AgentDoc>("agents")
  const rows = await agents.findBy("role", "coordinator")
  const now = Date.now()
  for (const entry of rows) {
    await agents.put(entry.id, {
      ...entry.doc,
      provider_id: providerId || toIndexable(null),
      model_id: modelId || toIndexable(null),
      updated_at: now,
    }, { expectedVersion: entry.version })
  }
}

export async function listEnabledCoordinatorNames(): Promise<string[]> {
  const agents = await col<AgentDoc>("agents")
  const order = ["bee", "scout", "builder", "verifier", "reviewer"]
  const rows = await agents.scan()
  return rows
    .map((entry) => entry.doc)
    .filter((agent) => agent.enabled && !!agent.agent_type)
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .map((agent) => agent.name)
}

export async function loadCodeCliState(): Promise<{
  mode: "plan" | "approval" | "auto"
  provider: string
  model: string
  projectPath: string
  taskCount: number
  tokenCount: number
}> {
  const configuredMode = await getCodeConfig("default_mode")
  const mode = configuredMode === "plan" || configuredMode === "approval" || configuredMode === "auto"
    ? configuredMode
    : "approval"
  const provider = await getDefaultProvider()
  const model = provider ? await getProviderModel(provider) : ""

  const sessions = await col<CodeSessionDoc>("codeSessions")
  const sessionRows = await sessions.scan()
  const latestSession = sessionRows
    .map((entry) => entry.doc)
    .sort((a, b) => b.id.localeCompare(a.id))[0]

  const tasks = await col<CodeTaskDoc>("codeTasks")
  const taskRows = await tasks.scan()
  const taskCount = taskRows
    .map((entry) => entry.doc)
    .filter((task) => task.status !== "cancelled" && task.status !== "completed")
    .length

  const traces = await col<CodeTraceDoc>("codeTraces")
  const traceTokens = (await traces.scan()).reduce((total, entry) => {
    return total + Number(entry.doc.tokens_in ?? 0) + Number(entry.doc.tokens_out ?? 0)
  }, 0)
  const taskTokens = taskRows.reduce((total, entry) => total + entry.doc.tokens_in + entry.doc.tokens_out, 0)

  return {
    mode,
    provider,
    model,
    projectPath: latestSession?.project_path ?? process.cwd(),
    taskCount,
    tokenCount: Math.max(traceTokens, taskTokens),
  }
}
