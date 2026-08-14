/**
 * Tracer — ACE Generator output.
 *
 * Records every agent execution to the HiveDB `traces` collection.
 * Fire-and-forget so tracing never blocks the main agent loop.
 */

import { col, nextId, updateDoc } from "../storage/hive"
import type { AgentDoc, TraceDoc } from "../storage/collections"
import { logger } from "../utils/logger"

const log = logger.child("tracer")

export interface TraceInput {
  threadId: string
  agentId: string
  agentName: string
  toolUsed?: string | null
  inputSummary: string
  outputSummary: string
  success: boolean
  errorMessage?: string | null
  durationMs?: number
  tokensUsed?: number
}

/**
 * Save a trace record. Non-blocking — errors are swallowed so they never
 * affect the main agent loop.
 */
export function saveTrace(trace: TraceInput): void {
  Promise.resolve().then(async () => {
    try {
      const traces = await col<TraceDoc>("traces")
      const id = await nextId("traces")
      const now = Date.now()
      await traces.put(id, {
        id,
        thread_id: trace.threadId,
        agent_id: trace.agentId,
        agent_name: trace.agentName,
        tool_used: trace.toolUsed ?? null,
        input_summary: trace.inputSummary.substring(0, 500),
        output_summary: trace.outputSummary.substring(0, 500),
        success: trace.success,
        error_message: trace.errorMessage ?? null,
        duration_ms: trace.durationMs ?? null,
        tokens_used: trace.tokensUsed ?? null,
        created_at: now,
      }, { expectedVersion: 0 })

      await updateDoc<AgentDoc>("agents", trace.agentId, { lastTraceAt: now }).catch(() => {})

      checkReflectorTrigger().catch(() => { /* ignore */ })
    } catch (err) {
      log.warn("[tracer] Failed to save trace:", err)
    }
  })
}

// ─── Reflector trigger ────────────────────────────────────────────────────────

const REFLECTOR_TRACE_THRESHOLD = 20
let tracesSinceLastReflection = 0

async function checkReflectorTrigger(): Promise<void> {
  tracesSinceLastReflection++
  if (tracesSinceLastReflection < REFLECTOR_TRACE_THRESHOLD) return
  tracesSinceLastReflection = 0

  const { runReflector } = await import("./reflector")
  runReflector().catch((err) => {
    log.warn("[tracer] Reflector run failed:", err)
  })
}

// ─── Usage recording ──────────────────────────────────────────────────────────

export function recordLLMUsage(opts: {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
}): void {
  Promise.resolve().then(async () => {
    try {
      const { recordUsage } = await import("../storage/usage")
      recordUsage({
        provider: opts.provider,
        model: opts.model,
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
      })
    } catch {
      // Usage is telemetry; never interrupt the agent loop.
    }
  })
}
