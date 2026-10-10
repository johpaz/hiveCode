/**
 * Tracer — ACE Generator output.
 *
 * Records every agent execution to the HiveDB `traces` collection.
 * Fire-and-forget so tracing never blocks the main agent loop.
 */

import { createHash } from "node:crypto"
import { col, nextId, updateDoc } from "../storage/hive"
import type { AgentDoc, ToolRunDoc, TraceDoc } from "../storage/collections"
import { logger } from "../utils/logger"
import { clipMiddle } from "./context-budget"

const log = logger.child("tracer")

/**
 * Most characters of one tool argument/result kept in HiveDB. The replayable
 * record is the point, but one `fs_read` of a lockfile must not become a
 * megabyte row; past this the middle is cut and a sha256 says what was lost.
 */
export const MAX_STORED_PAYLOAD_CHARS = 64_000

export function capStoredPayload(text: string, max = MAX_STORED_PAYLOAD_CHARS): string {
  if (text.length <= max) return text
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16)
  return clipMiddle(text, max, `sha256:${digest}`)
}

export interface CompletedToolRun {
  /** Run the call belongs to (agent-loop run id, or a code task). */
  runId: string
  taskId: string
  callId: string
  toolName: string
  args: unknown
  result: unknown
  success: boolean
  durationMs: number
  mutatesWorkspace?: boolean
}

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value
  try { return JSON.stringify(value) ?? "" } catch { return String(value) }
}

/**
 * Persist a finished tool call (full arguments and result, capped) and return
 * its id so a trace can link to it. Never throws: telemetry must not affect
 * the agent. Returns null when the write failed.
 */
export async function recordCompletedToolRun(run: CompletedToolRun): Promise<string | null> {
  try {
    const id = `${run.runId}:${run.callId}`
    const now = Math.floor(Date.now() / 1000)
    const toolRuns = await col<ToolRunDoc>("toolRuns")
    const existing = await toolRuns.get(id)
    const doc: ToolRunDoc = {
      id,
      run_id: run.runId,
      task_id: run.taskId,
      tool_name: run.toolName,
      call_id: run.callId,
      args_json: capStoredPayload(stringify(run.args)),
      result_json: capStoredPayload(stringify(run.result)),
      status: run.success ? "completed" : "failed",
      read_only: !run.mutatesWorkspace,
      mutates_workspace: run.mutatesWorkspace === true,
      mutates_db: false,
      started_at: now - Math.ceil(run.durationMs / 1000),
      completed_at: now,
      duration_ms: run.durationMs,
      error: run.success ? null : capStoredPayload(stringify(run.result), 2_000),
    }
    await toolRuns.put(id, doc, { expectedVersion: existing?.version ?? 0 })
    return id
  } catch (err) {
    log.debug(`[tracer] Failed to record tool run: ${(err as Error).message}`)
    return null
  }
}

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
  /** `toolRuns` row holding the full arguments and result behind this trace. */
  toolRunId?: string | null
  /** G9 causal stream this trace belongs to, for the reflector's thread analysis. */
  causalStreamId?: string | null
  /** Epoch fingerprint, so the reflector can spot a requalification boundary. */
  runEpoch?: string | null
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
        tool_run_id: trace.toolRunId ?? null,
        causal_stream_id: trace.causalStreamId ?? null,
        run_epoch: trace.runEpoch ?? null,
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
