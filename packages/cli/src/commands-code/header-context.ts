import { col, fromIndexable, ensureIndexes } from "@johpaz/hivecode-core/storage/hive"
import type { AgentDoc, AgentRunDoc, CodeConfigDoc, ModelDoc } from "@johpaz/hivecode-core/storage/collections"

/** Match the agent loop's model resolution without accessing credentials. */
export async function readCoordinatorContext(sessionId?: string) {
  const bee = (await (await col<AgentDoc>("agents")).get("bee"))?.doc
  const config = await col<CodeConfigDoc>("codeConfig")
  const defaultProvider = (await config.get("default_provider"))?.doc.value || "gemini"
  let provider = (bee?.model_selection !== "inherit" && fromIndexable(bee?.provider_id)) || defaultProvider
  let model = (bee?.model_selection !== "inherit" && fromIndexable(bee?.model_id))
    || (await config.get(`provider_model_${defaultProvider}`))?.doc.value || "gemini-2.5-flash"
  let catalogModel = (await (await col<ModelDoc>("models")).get(model))?.doc
  let inputTokens: number | null = null
  let estimated = false
  if (sessionId) {
    await ensureIndexes([["agentRuns", "session_id"]])
    const runs = (await (await col<AgentRunDoc>("agentRuns")).findBy("session_id", sessionId))
      .map(entry => entry.doc).filter(run => run.agent_id === "bee").sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at)
    try {
      const context = JSON.parse(runs[0]?.context_metrics_json || "{}").model_context
      if (context && Number.isFinite(context.input_tokens) && (
        (context.provider === provider && context.model === model) ||
        (context.configured_provider === provider && context.configured_model === model))) {
        provider = context.provider
        model = context.model
        catalogModel = (await (await col<ModelDoc>("models")).get(model))?.doc
        inputTokens = context.input_tokens
        estimated = context.estimated === true
      }
    } catch { /* Older runs do not contain per-call context telemetry. */ }
  }
  return {type: "coordinator_context" as const, agent: "bee", ...(sessionId && {session_id: sessionId}),
    provider, model, context_window: catalogModel?.context_window ?? null, input_tokens: inputTokens, estimated}
}
