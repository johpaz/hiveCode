/**
 * Sub-agent Worker — generic worker for spawning specialized sub-agents.
 *
 * Receives: { type: "SUBAGENT_TASK", systemPrompt, task, secrets?, provider?, model? }
 * Sends: { type: "SUBAGENT_RESULT", result, error? }
 *
 * This worker is spawned dynamically by coordinator workers.
 * It runs a single-turn or multi-turn agent loop depending on the task.
 */

import { callLLM } from "@johpaz/hive-code-core/agent/llm-client"
import type { LLMMessage } from "@johpaz/hive-code-core/agent/llm-client"
import { readWorkerSecrets } from "./secrets"

const COORDINATOR_PROVIDER = process.env.HIVE_COORDINATOR_PROVIDER || "anthropic"
const COORDINATOR_MODEL = process.env.HIVE_COORDINATOR_MODEL || "claude-sonnet-4-6"

/** Resolve API key using getEnvironmentData → env fallback */
function resolveApiKey(provider: string, taskSecrets?: Record<string, string>): string {
  const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`
  const envSecrets = readWorkerSecrets()
  if (envSecrets?.[envKey]) return envSecrets[envKey]
  if (envSecrets?.["LLM_API_KEY"]) return envSecrets["LLM_API_KEY"]
  if (taskSecrets?.[envKey]) return taskSecrets[envKey]
  if (taskSecrets?.["LLM_API_KEY"]) return taskSecrets["LLM_API_KEY"]
  const envValue = process.env[envKey] || process.env.LLM_API_KEY || ""
  if (envValue) return envValue
  throw new Error(`No API key found for provider "${provider}"`)
}

interface SubAgentTask {
  systemPrompt: string
  task: string
  secrets?: Record<string, string>
  provider?: string
  model?: string
  temperature?: number
  maxTokens?: number
  tools?: any[] // LLMToolDef[] serialized
}

interface SubAgentResult {
  type: "SUBAGENT_RESULT"
  result: string
  error?: string
  durationMs: number
}

declare var self: {
  onmessage: ((event: { data: { type: string } & SubAgentTask }) => void) | null
  postMessage(message: SubAgentResult): void
}

self.onmessage = async (event) => {
  const msg = event.data

  if (msg.type !== "SUBAGENT_TASK") {
    self.postMessage({
      type: "SUBAGENT_RESULT",
      result: "",
      error: `Unknown message type: ${msg.type}`,
      durationMs: 0,
    })
    return
  }

  const startTime = performance.now()

  try {
    const provider = msg.provider || COORDINATOR_PROVIDER
    const model = msg.model || COORDINATOR_MODEL
    const apiKey = resolveApiKey(provider, msg.secrets)

    const messages: LLMMessage[] = [
      { role: "system", content: msg.systemPrompt },
      { role: "user", content: msg.task },
    ]

    // If tools are provided, we do a multi-turn loop (simplified)
    // For now, sub-agents are single-turn to keep it simple
    const response = await callLLM({
      provider,
      model,
      apiKey,
      messages,
      temperature: msg.temperature ?? 0.2,
      maxTokens: msg.maxTokens ?? 4096,
    })

    const durationMs = Math.round(performance.now() - startTime)

    self.postMessage({
      type: "SUBAGENT_RESULT",
      result: response.content || "No output generated",
      durationMs,
    })
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime)
    self.postMessage({
      type: "SUBAGENT_RESULT",
      result: "",
      error: (err as Error).message,
      durationMs,
    })
  }
}
