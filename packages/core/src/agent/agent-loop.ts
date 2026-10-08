import { runWithTaskSignal } from "../runtime/task-execution"
/**
 * Agent Loop — native implementation, no LangGraph.
 *
 * Replaces supervisor.ts + graph.ts.
 *
 * Pattern:
 *   user message → context compiler → model call → [tool call → model call]* → response
 *
 * Exposes an async generator compatible with the existing providers/index.ts stream API:
 *   yield { agent: { messages: [AIMessage] } }
 *   yield { tools: { messages: [ToolMessage] } }
 *
 * Also used directly by runAgentIsolated() for worker tasks.
 */

import { logger } from "../utils/logger"
import { getHiveDb } from "../storage/hivedb"
import { causalLogEnabled } from "../storage/causal-events"
import type { HiveDB } from "@johpaz/hive-db"
import { col, fromIndexable } from "../storage/hive"
import type { AgentDoc, AgentRunDoc, AgentRunStatus, CodeConfigDoc, SkillDoc, ToolRunDoc } from "../storage/collections"
import { callLLM, resolveProviderConfig, type LLMMessage } from "./llm-client"
import { addMessage } from "./conversation-store"
import { saveTrace, recordLLMUsage } from "./tracer"
import { maybeCompact, clearOldToolResults } from "./compaction"
import { capToolResult, fitLoopMessages, messageBudget, messageTokens } from "./context-budget"
import type { MCPClientManager } from "@johpaz/hivecode-mcp"
import { compileContext } from "./context-compiler"
import { jevWantsParallel } from "./jev-planner"
import { emitJevDecision } from "./jev-decisions"
import { formatToolResult } from "../utils/toon"
import { getAverageTokenCost } from "../storage/usage"
import type { ContentPart } from "./llm-client"
import { getExecutionMode, canExecuteTool, requiresConfirmation, getBlockReason } from "./execution-mode"
import { planJevIteration } from "./jev-planner"
import { createStuckLoopDetector, getInterventionMessage } from "./stuck-loop"
import { buildRunEpoch, formatEpochKey } from "./run-epoch"
import {
  writeCheckpoint,
  readCheckpoint,
  reclaimRun,
  startLeaseRenewal,
  leaseOwner,
  LEASE_SECONDS,
  type RunCheckpoint,
  type RepeatTrackerSnapshot,
} from "./run-store"
import { broadcastThinking } from "../gateway/task-streaming"
import { emitLoadout, emitToolCall, emitToolDone, emitWaiting, summarizeArgs } from "./tool-telemetry"

/**
 * Execute a tool by name from the available tools list
 * This is a local helper function since executeTool is not exported elsewhere
 *
 * Returns: JS object normal (se encodea solo al enviar al LLM)
 */
async function executeTool(
  allTools: Array<{ name: string; execute?: (params: Record<string, unknown>, config?: any) => Promise<unknown> }>,
  toolName: string,
  args: unknown,
  config: { user_id?: string; thread_id?: string; channel?: string; workspace?: string | null; signal?: AbortSignal; agent_id?: string; run_id?: string; approved_execution?: boolean }
): Promise<unknown> {
  const tool = allTools.find(t => t.name === toolName)
  if (!tool?.execute) {
    return { error: true, message: `Tool '${toolName}' not found or not executable` }
  }
  try {
    const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
    return await runWithTaskSignal(config.signal, () => tool.execute(parsedArgs as Record<string, unknown>, { configurable: config, signal: config.signal }))
  } catch (err) {
    return {
      error: true,
      tool: toolName,
      message: (err as Error).message,
      timestamp: new Date().toISOString(),
    }
  }
}

const log = logger.child("agent-loop")

const DEFAULT_HARNESS_MAX_STEPS = 200
const DEFAULT_CHECKPOINT_EVERY = 10
/** Identical call count that earns a corrective nudge in the tool result. */
const REPEAT_TOOL_CALL_NUDGE = 2
/** Identical call count that ends the run as stalled. */
const REPEAT_TOOL_CALL_LIMIT = 4
/** How many recent signatures to keep, so A-B-A-B oscillation is still visible. */
const REPEAT_WINDOW = 8
/** Calls of one tool with no other tool in between before we warn it is spinning. */
const SINGLE_TOOL_DOMINANCE_NUDGE = 3
/** Calls of one tool with no other tool in between before we treat it as spinning. */
const SINGLE_TOOL_DOMINANCE_LIMIT = 5
/** Sampling temperature for the tool-calling loop. Matches the worker loop's 0.3. */
const TOOL_CALLING_TEMPERATURE = 0.3
/** Steps left at which the model is told to wrap up. */
const WRAP_UP_STEPS_REMAINING = 3
const WORKSPACE_MUTATION_TOOLS = new Set([
  "fs_write", "fs_edit", "fs_delete", "shell_executor", "run_script",
  "git_commit", "git_rollback", "speckit_init", "speckit_artifact_write",
])
const DB_MUTATION_TOOLS = new Set([
  "save_note", "memory_write", "write_memory", "memory_delete",
  "speckit_tasks_sync", "speckit_converge",
])

// Stuck-loop and stall detection. RepeatTracker notices the model repeating
// itself; this catches the retry loop that keeps failing and the run that is
// busy without advancing — neither of which shows up as a repeat.
const stuckDetector = createStuckLoopDetector()

function safeParse(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}

/** Tool arguments as a plain object, whatever shape they arrived in. */
function toArgsRecord(argsJson: string | undefined): Record<string, unknown> {
  const parsed = argsJson === undefined ? undefined : safeParse(argsJson)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

/**
 * Fingerprint of what a run has achieved rather than what it has said: the
 * sequence of tool names and whether each succeeded. Two turns that produced the
 * same tools with the same outcomes are the same state, even if the prose
 * differs — which is exactly the pair a stall looks like.
 */
function progressFingerprint(messages: LLMMessage[]): string {
  const shape: string[] = []
  for (const m of messages) {
    if (m.role === "tool") {
      const failed = typeof m.content === "string"
        && (m.content.startsWith("[Tool Error]") || m.content.includes('"error":true'))
      shape.push(`${m.name ?? "?"}:${failed ? "x" : "ok"}`)
    }
  }
  return shape.slice(-8).join(",")
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Stable signature for a tool call: name + canonicalized arguments.
 *
 * Keys are sorted so that `{a,b}` and `{b,a}` collapse to one signature — models
 * reorder them freely between turns and the raw JSON string would read as new work.
 */
function toolCallSignature(toolName: string, args: unknown): string {
  let parsed: unknown = args
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args)
    } catch {
      return `${toolName}:${args}`
    }
  }
  return `${toolName}:${canonicalJSON(parsed)}`
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(",")}}`
}

/**
 * Tracks tool-call repetition across a whole run.
 *
 * The previous check only compared against the immediately preceding signature and
 * included raw arguments, so it never fired for the case that actually stalls runs:
 * the same tool called over and over with slightly different payloads. This counts
 * signatures for the whole run, keeps a sliding window so alternating patterns stay
 * visible, and tracks how long one tool has monopolized the run.
 */
class RepeatTracker {
  private readonly counts = new Map<string, number>()
  private window: string[] = []
  private lastToolName = ""
  private sameToolStreak = 0

  /** Records a call and reports whether it warrants a nudge or a hard stop. */
  record(toolName: string, signature: string): "ok" | "nudge" | "stop" {
    const count = (this.counts.get(signature) ?? 0) + 1
    this.counts.set(signature, count)

    this.window.push(signature)
    if (this.window.length > REPEAT_WINDOW) this.window.shift()

    if (toolName === this.lastToolName) {
      this.sameToolStreak++
    } else {
      this.lastToolName = toolName
      this.sameToolStreak = 1
    }

    if (count >= REPEAT_TOOL_CALL_LIMIT) return "stop"
    if (this.sameToolStreak >= SINGLE_TOOL_DOMINANCE_LIMIT) return "stop"
    if (count >= REPEAT_TOOL_CALL_NUDGE) return "nudge"
    // The stall that actually burns budgets: one tool hammered with a slightly
    // different payload each time, so no two signatures ever match.
    if (this.sameToolStreak >= SINGLE_TOOL_DOMINANCE_NUDGE) return "nudge"
    // Oscillation: the window holds only a couple of distinct calls, all repeated.
    if (this.window.length === REPEAT_WINDOW && new Set(this.window).size <= 2) return "nudge"
    return "ok"
  }

  countFor(signature: string): number {
    return this.counts.get(signature) ?? 0
  }

  streakFor(toolName: string): number {
    return this.lastToolName === toolName ? this.sameToolStreak : 0
  }

  /**
   * Serialize the detection state. A resumed run that was mid-loop must still be
   * considered mid-loop — restoring the messages without restoring this would
   * hand a looping run a clean slate on every crash.
   */
  snapshot(): RepeatTrackerSnapshot {
    return {
      counts: Object.fromEntries(this.counts),
      window: [...this.window],
      lastToolName: this.lastToolName,
      sameToolStreak: this.sameToolStreak,
    }
  }

  static restore(snap: RepeatTrackerSnapshot | null | undefined): RepeatTracker {
    const tracker = new RepeatTracker()
    if (!snap) return tracker
    for (const [signature, count] of Object.entries(snap.counts ?? {})) {
      tracker.counts.set(signature, count)
    }
    tracker.window = [...(snap.window ?? [])].slice(-REPEAT_WINDOW)
    tracker.lastToolName = snap.lastToolName ?? ""
    tracker.sameToolStreak = snap.sameToolStreak ?? 0
    return tracker
  }
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function textFromMessage(message: string | ContentPart[]): string {
  return typeof message === "string"
    ? message
    : Array.isArray(message)
      ? message.filter(p => p.type === "text").map(p => (p as any).text).join("\n")
      : String(message)
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentLoopOptions {
  agentId: string
  userMessage: string | ContentPart[]
  threadId: string
  channel?: string
  mcpManager?: MCPClientManager | null
  /** System prompt override (from server.ts config) */
  systemPromptOverride?: string
  /** Worker mode: isolated context + single-task execution */
  isolated?: boolean
  taskContext?: string | ContentPart[]
  onStep?: (step: StepEvent) => Promise<void>
  /** User ID for context propagation */
  userId?: string
  /** Abort signal to stop generation mid-execution */
  signal?: AbortSignal
  /** Clean text for capability search and tracing (extracted from userMessage if multimodal) */
  rawUserMessage?: string
  /** Durable parent run for DAG/handoff tracing. */
  parentRunId?: string
  /** Explicit run purpose for observability. */
  runKind?: AgentRunDoc["kind"]
  /** The harness already passed its explicit approval gate for this run. */
  approvedExecution?: boolean
  /** Per-run ceiling used by the harness to keep orchestration token-bounded. */
  maxSteps?: number
  /** Answer tokens as the model produces them. Drives `assistant_chunk`. */
  onToken?: (token: string) => void
  /** Reasoning tokens as the model produces them. Drives `thought_chunk`. */
  onReasoningToken?: (token: string) => void
  /**
   * Resume this run from its checkpoint instead of starting a new one. The
   * restored messages are already the pruned set, so the Jev pass is skipped.
   */
  resume?: boolean
  /**
   * Persist a full resumable snapshot of this run. On by default; set false for
   * work whose transcript is not worth the write (bulk replays, evals).
   */
  resumable?: boolean
  /** Existing run to resume. Implies `resume`. */
  resumeRunId?: string
}

export interface StepEvent {
  type: "text" | "tool_call" | "tool_result"
  message: string
  toolName?: string
  isError?: boolean
}

// ─── G9 causal event log ─────────────────────────────────────────────────────

/**
 * Append one G9 causal event to HiveDB's immutable event log. Never throws: a
 * broken causal log must never break the agent loop — it is an observability
 * spine, not a dependency.
 *
 * `causation` chains each event to the previous one, which is what
 * causalThread() walks to reconstruct a decision chain, and `correlation`
 * groups a whole invocation.
 */
async function appendCausalEvent(
  db: HiveDB,
  input: {
    agentId: string
    streamId: string
    kind: string
    payload: Record<string, unknown>
    causation?: number
    correlation?: string
  },
): Promise<number | undefined> {
  try {
    return await db.append({
      agentId: input.agentId,
      streamId: input.streamId,
      kind: input.kind as never,
      payload: JSON.stringify(input.payload),
      causation: input.causation,
      correlation: input.correlation,
    })
  } catch (err) {
    log.warn(`[agent-loop] causal event append failed (kind=${input.kind}): ${(err as Error).message}`)
    return undefined
  }
}

// ─── Stream chunk types (compatible with providers/index.ts) ─────────────────

export interface StreamChunk {
  agent?: { messages: any[] }
  tools?: { messages: any[] }
  usage?: { input_tokens: number; output_tokens: number }
  run?: { status: AgentRunStatus; blocker: string | null }
}

// ─── Main agent loop ──────────────────────────────────────────────────────────

export async function* runAgent(
  opts: AgentLoopOptions
): AsyncGenerator<StreamChunk> {
  const t0 = performance.now()

  // Load agent config from HiveDB.
  const agents = await col<AgentDoc>("agents")
  const agent = (await agents.get(opts.agentId))?.doc
  if (!agent) throw new Error(`Agent not found: ${opts.agentId}`)

  const agentName = agent.name || opts.agentId
  const checkpointEvery = Math.min(parsePositiveInt(agent.max_iterations, DEFAULT_CHECKPOINT_EVERY), DEFAULT_CHECKPOINT_EVERY)
  const maxSteps = parsePositiveInt(
    opts.maxSteps
      ?? process.env.HIVECODE_AGENT_MAX_STEPS
      ?? ((agent as AgentDoc & { max_steps?: number }).max_steps)
      ?? agent.max_iterations,
    DEFAULT_HARNESS_MAX_STEPS,
  )
  const maxInputTokens = Number(agent.max_input_tokens || 0)
  const maxOutputTokens = Number(agent.max_output_tokens || 0)
  const objective = opts.rawUserMessage || textFromMessage(opts.userMessage)
  // A resumed run keeps its id so the G9 chain continues instead of splitting.
  const runId = opts.resumeRunId || `${opts.threadId}:${opts.agentId}:${Date.now()}`
  let runStatus: AgentRunStatus = "running"
  let blocker: string | null = null
  /** Whether this run keeps a full snapshot. Off for evals and bulk replays. */
  const isResumable = opts.resumable !== false

  // ── G9 causal stream ──────────────────────────────────────────────────────
  // One stream per invocation (this turn or this worker task), NOT the
  // persistent threadId: causalThread() reconstructs without a checkpointed
  // projection, so a months-old thread would be O(full history) on every call.
  // The run id is reused as the stream id, which also makes resume land in the
  // same chain instead of starting a second one.
  const causalDb = causalLogEnabled() ? await getHiveDb() : null
  const causalStreamId = runId
  // hive has no mid-turn topic-change classifier, so the whole stream shares one
  // correlation id; objectiveDrift is wired but will not fire until that exists.
  const causalCorrelationId = crypto.randomUUID()
  let lastCausalSeq: number | undefined

  if (causalDb) {
    lastCausalSeq = await appendCausalEvent(causalDb, {
      agentId: opts.agentId,
      streamId: causalStreamId,
      kind: "IntentLogged",
      payload: { actor: opts.agentId, intent: objective.slice(0, 2000) },
      correlation: causalCorrelationId,
    })
  }

  const agentRuns = await col<AgentRunDoc>("agentRuns")
  async function updateRun(patch: Partial<AgentRunDoc>): Promise<void> {
    try {
      const existing = await agentRuns.get(runId)
      if (!existing) return
      await agentRuns.put(runId, {
        ...existing.doc,
        ...patch,
        ...(patch.status === "running" ? { lease_expires_at: nowSec() + LEASE_SECONDS } : {}),
        updated_at: nowSec(),
      }, { expectedVersion: existing.version })
    } catch (err) {
      log.debug(`[agent-loop] Failed to update run ${runId}: ${(err as Error).message}`)
    }
  }

  /** Snapshot the run so a crash can be resumed from this exact point. */
  async function checkpoint(pending: RunCheckpoint["pendingToolCalls"], label: string): Promise<void> {
    if (!isResumable) return
    await writeCheckpoint(runId, {
      version: 1,
      messages,
      iterations,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      repeats: repeats.snapshot(),
      pendingToolCalls: pending,
    }).then((ok) => {
      if (!ok) log.debug(`[agent-loop] ${label} checkpoint not written for ${runId}`)
    })
  }

  // Renewal stops as soon as the run stops being "running" — a lease for a
  // finished run is what keeps it looking abandoned, not owned.
  const stopLeaseRenewal = startLeaseRenewal(runId, { isActive: () => runStatus === "running" })

  // A resumed run already has its row; recreating it would wipe the very
  // checkpoint being resumed from. Reclaim instead, so the lease renewer has an
  // owner to renew for.
  const isResume = !!(opts.resume || opts.resumeRunId)

  if (isResume) {
    await reclaimRun(runId).catch((err) =>
      log.warn(`[agent-loop] Failed to reclaim run ${runId}: ${(err as Error).message}`)
    )
  } else {
    try {
      const ts = nowSec()
      await agentRuns.put(runId, {
        id: runId,
        task_id: opts.threadId,
        thread_id: opts.threadId,
        session_id: opts.threadId,
        agent_id: opts.agentId,
        kind: opts.runKind ?? (opts.isolated ? "worker" : "harness"),
        parent_run_id: opts.parentRunId ?? null,
        profile_type: agent.agent_type,
        objective,
        status: "running",
        turn: 0,
        max_turns: maxSteps,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        checkpoint_json: null,
        blocker: null,
        next_action: null,
        lease_owner: leaseOwner(),
        lease_expires_at: ts + LEASE_SECONDS,
        created_at: ts,
        updated_at: ts,
        completed_at: null,
      })
    } catch (err) {
      log.debug(`[agent-loop] Failed to create run ${runId}: ${(err as Error).message}`)
    }
  }

  // Resolve LLM provider config — prefer agent's provider_id, fall back to codeConfig.
  let provId = fromIndexable(agent.provider_id) ?? ""
  let modId = fromIndexable(agent.model_id) ?? ""
  if (!provId || !modId) {
    const codeConfig = await col<CodeConfigDoc>("codeConfig")
    const cfgRow = await codeConfig.get("default_provider")
    const fallbackProvider = cfgRow?.doc.value || "gemini"
    const modelKey = `provider_model_${fallbackProvider}`
    const modelRow = await codeConfig.get(modelKey)
    provId = provId || fallbackProvider
    modId = modId || modelRow?.doc.value || "gemini-2.5-flash"
  }
  let providerCfg = await resolveProviderConfig(provId, modId)
  const fallbackProvider = fromIndexable(agent.fallback_provider_id)
  const fallbackModel = fromIndexable(agent.fallback_model_id)
  let fallbackCfg = fallbackProvider && fallbackModel
    ? await resolveProviderConfig(fallbackProvider, fallbackModel)
    : null
  let fallbackUsed = false
  const requestedThinkingBudget = agent.effort === "max" ? 32_000
    : agent.effort === "xhigh" ? 16_000
      : agent.effort === "high" ? 8_000
        : 0
  const thinkingBudget = maxOutputTokens > 0
    ? Math.max(0, Math.min(requestedThinkingBudget, maxOutputTokens - 1024))
    : requestedThinkingBudget
  const profileCallOptions = {
    ...(maxOutputTokens > 0 ? { maxTokens: maxOutputTokens } : {}),
    ...(thinkingBudget > 0 ? { thinking: { enabled: true, budget_tokens: thinkingBudget } } : {}),
    // Tool calling wants determinism. The provider default is 0.7, which on smaller local
    // models produces erratic, repetitive calls; the worker loop already runs at 0.3.
    temperature: TOOL_CALLING_TEMPERATURE,
  }

  async function callProfileLLM(request: Parameters<typeof callLLM>[0]) {
    // Todas las llamadas del run son de la misma conversación: los providers que
    // rutean o cachean por sesión (OpenCode Go) lo necesitan, y el fallback de
    // abajo lo conserva porque providerCfg no trae sessionId.
    request = { sessionId: opts.threadId, ...request }
    try {
      return await callLLM(request)
    } catch (error) {
      if (!fallbackCfg || fallbackUsed) throw error
      fallbackUsed = true
      providerCfg = fallbackCfg
      fallbackCfg = null
      log.warn(
        `[agent-loop] Primary provider failed; switching run=${runId} ` +
        `to fallback=${providerCfg.provider}/${providerCfg.model}: ${(error as Error).message}`,
      )
      return callLLM({ ...request, ...providerCfg })
    }
  }

  const cleanModel = providerCfg.model.replace(new RegExp(`^${providerCfg.provider}\\/`), "")

  log.info(`[agent-loop] Starting harness: run=${runId} agent=${agentName} thread=${opts.threadId} provider=${providerCfg.provider}/${cleanModel} maxSteps=${maxSteps} checkpointEvery=${checkpointEvery}`)

  // Store the user message in conversation history
  if (!opts.isolated) {
    // If userMessage is multimodal, addMessage extracts text for history storage
    await addMessage(opts.threadId, "user", opts.userMessage, { channel: opts.channel })
    // Run compaction if conversation history is getting large
    await maybeCompact(
      opts.threadId,
      opts.channel && opts.userId
        ? { channel: opts.channel, userId: opts.userId }
        : undefined
    )
  }

  // Compile context (system prompt + history + tools)
  const ctx = await compileContext({
    agentId: opts.agentId,
    threadId: opts.threadId,
    userMessage: opts.userMessage,
    channel: opts.channel,
    mcpManager: opts.mcpManager,
    isolated: opts.isolated,
    taskContext: opts.taskContext,
    userId: opts.userId,
    causalStreamId: causalDb ? causalStreamId : undefined,
    // The restored messages are already the pruned set from the run that
    // checkpointed them; pruning them again would compound the loss.
    skipJev: isResume,
    contextWindow: providerCfg.contextWindow,
    // La ficha del especialista muestra la carga de ESTE turno, no el perfil
    // declarado: JEV poda y el descubrimiento amplía, así que la lista cambia
    // aunque el agente no haya descubierto nada nuevo.
    onLoadout: (loadout) => emitLoadout({ agentId: opts.agentId, ...loadout }),
  })

  // Conditions this run executes under, stamped on every trace it produces.
  // Traces from one epoch are comparable to each other; across a boundary they
  // are not, and the reflector needs to see where it fell.
  const runEpochKey = formatEpochKey(buildRunEpoch({
    provider: providerCfg.provider,
    model: providerCfg.model,
    toolNames: ctx.tools.map(t => t.function.name),
  }))

  const systemPrompt = opts.systemPromptOverride
    ? opts.systemPromptOverride + ctx.conversationSummarySection
    : ctx.systemPrompt

  // Build initial messages array for the model
  let messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...ctx.messages,
  ]

  // For isolated workers the user message is the task context, not from history
  if (opts.isolated) {
    messages.push({ role: "user", content: opts.userMessage })
  }

  // What actually goes to the model each call: old tool results cleared harder
  // as the window fills, then whole oldest turns dropped if that is not enough.
  // `messages` itself stays complete for persistence and checkpoints.
  const prepareMessages = (all: LLMMessage[], tools: unknown): LLMMessage[] => {
    const budget = messageBudget(providerCfg.contextWindow, tools)
    let prepared = clearOldToolResults(all) as LLMMessage[]
    if (prepared.reduce((sum, m) => sum + messageTokens(m), 0) > budget * 0.7) {
      prepared = clearOldToolResults(all, 2) as LLMMessage[]
    }
    const fit = fitLoopMessages(prepared, budget)
    if (fit.dropped > 0 || fit.messages !== prepared) {
      log.info(`[agent-loop] Context budget: ${all.length} → ${fit.messages.length} msgs (dropped ${fit.dropped}), ~${fit.tokens}/${budget} tokens`)
    }
    return fit.messages
  }

  let iterations = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUsd = 0
  let finalContent = ""
  let finalContentEmitted = false
  // Loop detection: counts repeated calls across the whole run, nudging before breaking.
  let repeats = new RepeatTracker()
  let loopDetected = false
  let wrapUpAnnounced = false

  // ── Resume from checkpoint ────────────────────────────────────────────────
  // The restored messages are already the pruned set from the run that wrote
  // them, so the Jev pass must not prune them again.
  if (isResume) {
    const restored = await readCheckpoint(runId)
    if (restored) {
      messages = restored.messages
      iterations = restored.iterations ?? 0
      totalInputTokens = restored.totalInputTokens ?? 0
      totalOutputTokens = restored.totalOutputTokens ?? 0
      totalCostUsd = restored.totalCostUsd ?? 0
      repeats = RepeatTracker.restore(restored.repeats)

      const interrupted = (restored.pendingToolCalls ?? []).map((tc) => ({
        role: "tool" as const,
        content: "[interrupted] El proceso se reinició mientras esta herramienta corría. El resultado no está disponible — decide si reintentar o continuar sin él.",
        tool_call_id: tc.id,
        name: tc.name,
      }))
      if (interrupted.length > 0) {
        // Synthesized rather than re-executed: a tool that may have half-run
        // must not be run again just because the process died.
        messages.push(...interrupted)
        // Clear them from the checkpoint immediately. They are now answered in
        // the transcript, and leaving them set means a second crash injects the
        // same replies again — duplicate tool results for one call_id, which
        // providers reject.
        await checkpoint([], "resume-clear")
        log.info(`[agent-loop] Resume: injected ${interrupted.length} synthetic [interrupted] tool message(s)`)
      }
      log.info(
        `[agent-loop] Resume: restored ${messages.length} messages at iteration ${iterations} ` +
        `from run ${runId}`,
      )
    } else {
      log.info(`[agent-loop] Resume requested but run ${runId} has no usable checkpoint — starting fresh`)
    }
  }

  // The try wraps the loop, the synthesis and the finalization without
  // re-indenting any of it: it guarantees a run never stays "running" with a
  // live lease when the loop throws or the consumer abandons the generator.
  try {
  // ── The loop ────────────────────────────────────────────────────────────
  while (iterations < maxSteps) {
    if (opts.signal?.aborted) {
      log.info(`[agent-loop] Aborted by signal at iteration ${iterations}`)
      finalContent = "Generación detenida."
      runStatus = "cancelled"
      blocker = "aborted_by_signal"
      break
    }

    iterations++

    if ((maxInputTokens > 0 && totalInputTokens >= maxInputTokens)
      || (maxOutputTokens > 0 && totalOutputTokens >= maxOutputTokens)
      || (Number(agent.max_cost_usd || 0) > 0 && totalCostUsd >= Number(agent.max_cost_usd))) {
      runStatus = "needs_budget"
      blocker = maxInputTokens > 0 && totalInputTokens >= maxInputTokens
        ? `max_input_tokens:${maxInputTokens}`
        : maxOutputTokens > 0 && totalOutputTokens >= maxOutputTokens
          ? `max_output_tokens:${maxOutputTokens}`
          : `max_cost_usd:${agent.max_cost_usd}`
      break
    }

    // Jev decides whether the history gathered so far is still worth paying for,
    // and whether the turn is done. Skipped below the prune threshold: a
    // decision costs latency, so it only runs when there is real weight to drop.
    // Any failure leaves messages and the loadout exactly as they were.
    const jevIteration = await planJevIteration({
      objective: typeof opts.userMessage === "string"
        ? opts.userMessage
        : Array.isArray(opts.userMessage)
          ? opts.userMessage.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n")
          : String(opts.userMessage),
      messages,
      tools: ctx.tools,
    }).catch((err) => {
      log.warn(`[agent-loop] Jev iteration fallback: ${(err as Error).message}`)
      return null
    })

    if (jevIteration) {
      messages = jevIteration.messages
      ctx.tools = jevIteration.tools
      log.info(
        `[agent-loop] Jev action=${jevIteration.action} omitted=${jevIteration.omittedResults} ` +
        `msgs=${messages.length} tools=${ctx.tools.length} (${jevIteration.decision.latencyMs}ms)`,
      )
      emitJevDecision({
        agentId: opts.agentId,
        kind: "iteration",
        provider: provId,
        model: modId,
        summary: `${jevIteration.action} · ${jevIteration.omittedResults} resultados podados`,
        savedTokens: 0,
        costUsd: jevIteration.decision.costUsd,
        latencyMs: jevIteration.decision.latencyMs,
      })
      // "finish" is not a break: it empties the tool loadout so the next call
      // has to compose a text answer. The loop exits on that answer, through
      // the normal path.
    }

    if (iterations > 1 && (iterations - 1) % checkpointEvery === 0) {
      await updateRun({
        status: "running",
        turn: iterations - 1,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        checkpoint_json: JSON.stringify({
          iterations: iterations - 1,
          messages: messages.length,
          totalInputTokens,
          totalOutputTokens,
        }),
        next_action: "continue",
      })
      if (!opts.isolated) {
        await maybeCompact(
          opts.threadId,
          opts.channel && opts.userId
            ? { channel: opts.channel, userId: opts.userId }
            : undefined
        )
      }
      log.info(`[agent-loop] Checkpoint: run=${runId} iteration=${iterations - 1}/${maxSteps}`)
    }

    // Force a final response as the loop nears its limit — WITHOUT telling the model
    // how many steps remain. Same reasoning as the worker loop: a visible countdown
    // ("context anxiety") makes models misjudge it and rush or abandon work. The
    // harness enforces the ceiling silently. Sent once, on the turn we cross it.
    if (maxSteps - iterations <= WRAP_UP_STEPS_REMAINING && !wrapUpAnnounced) {
      wrapUpAnnounced = true
      messages.push({
        role: "user",
        content:
          `⚠️ STOPPING: cierra ahora. Responde con tu respuesta FINAL en texto, sin más `
          + `llamadas a herramientas. Resume lo que hiciste y, si el objetivo no quedó `
          + `completo, dilo explícitamente junto al siguiente paso.`,
      })
      log.info(`[agent-loop] Wrap-up signal sent: run=${runId} iteration=${iterations}/${maxSteps}`)
    }

    const response = await callProfileLLM({
      ...providerCfg,
      ...profileCallOptions,
      messages: prepareMessages(messages, ctx.tools),
      tools: ctx.tools.length > 0 ? ctx.tools : undefined,
      signal: opts.signal,
      onToken: opts.onToken,
      onReasoningToken: opts.onReasoningToken,
    })

    // Accumulate usage
    if (response.usage) {
      totalInputTokens += response.usage.input_tokens
      totalOutputTokens += response.usage.output_tokens
      totalCostUsd += (
        response.usage.input_tokens + response.usage.output_tokens
      ) * getAverageTokenCost(providerCfg.model)
    }

    // G9: this model turn is the decision that follows the previous event in the
    // chain. Logging it before the tool calls it implies keeps the reconstructed
    // thread in causal order.
    if (causalDb) {
      const description = response.content?.trim()
        || (response.tool_calls?.length
          ? `Calling ${response.tool_calls.map((tc) => tc.function.name).join(", ")}`
          : "(empty response)")
      const seq = await appendCausalEvent(causalDb, {
        agentId: opts.agentId,
        streamId: causalStreamId,
        kind: "StateTransition",
        payload: { description: description.slice(0, 2000) },
        causation: lastCausalSeq,
        correlation: causalCorrelationId,
      })
      if (seq !== undefined) lastCausalSeq = seq
    }

    // Bifurcate thinking blocks: reasoning_content → WS canal agent:{id}:thinking
    // The content is persisted in DB alongside the assistant message (see below).
    // Here we only broadcast it to dashboard subscribers for real-time display.
    if (response.reasoning_content) {
      broadcastThinking(opts.agentId, {
        content: response.reasoning_content,
        taskId: opts.threadId,
      })
    }

    // Emit agent chunk (compatible with providers/index.ts)
    const agentMsg: any = { content: response.content }
    if (response.tool_calls?.length) agentMsg.tool_calls = response.tool_calls
    yield { agent: { messages: [agentMsg] } }

    // Notify onStep for narration text
    if (opts.onStep && response.content) {
      await opts.onStep({ type: "text", message: response.content })
    }

    // ── No tool calls → final response ──────────────────────────────────
    // Gate on the tool calls alone. Keying off stop_reason used to drop calls that
    // arrived with finish_reason "stop" — the shape llama.cpp/LM Studio emit for
    // several templates, and the only shape possible when the calls were recovered
    // from text — which stopped the run on its very first turn.
    if (!response.tool_calls?.length) {
      finalContent = response.content?.trim() || ""
      // callLLM swallows provider failures and returns them as "[LLM Error] …"
      // content. Without this branch the run would be reported as completed
      // even though the model never actually answered. An abort also surfaces
      // here — the signal now cancels the in-flight request — but that is a
      // cancellation, not a provider failure.
      if (response.stop_reason === "error" && opts.signal?.aborted) {
        finalContent = "Generación detenida."
        runStatus = "cancelled"
        blocker = "aborted_by_signal"
      } else if (response.stop_reason === "error") {
        runStatus = "failed"
        blocker = finalContent.slice(0, 200) || "llm_error"
      } else if (response.stop_reason === "max_tokens") {
        // The turn was cut mid-generation: whatever text exists is truncated, not an
        // answer. Fall through to the synthesis pass rather than reporting success.
        runStatus = "blocked"
        blocker = "output_truncated"
        log.warn(`[agent-loop] Response truncated by max_tokens at iteration ${iterations} — falling through to synthesis`)
        finalContent = ""
      } else {
        runStatus = finalContent ? "completed" : "blocked"
        if (!finalContent) blocker = "model_returned_no_tool_calls_and_no_content"
      }
      // Only save to history if we have real content; empty → synthesis block will handle it
      if (finalContent && !opts.isolated) {
        await addMessage(opts.threadId, "assistant", finalContent)
      }
      finalContentEmitted = true
      break
    }

    // ── Tool calls → execute each tool ──────────────────────────────────
    // Add assistant message with tool_calls to local messages array AND persist
    messages.push({
      // Some llama.cpp chat templates reject an assistant turn whose content is null
      // while it carries tool_calls, so normalize to "" here.
      content: response.content ?? "",
      role: "assistant",
      tool_calls: response.tool_calls,
      reasoning_content: response.reasoning_content,
    })
    if (!opts.isolated) {
      await addMessage(opts.threadId, "assistant", response.content || "", {
        channel: opts.channel,
        tool_calls: response.tool_calls,
        reasoning_content: response.reasoning_content,
      })
    }

    // Group tools to execute in parallel when possible
    const toolCalls = response.tool_calls
    const results: Array<{ toolResultLLM: string, toolResultJS?: unknown, id: string, name: string, ms: number, sig: string, argsJson?: string }> = []

    // Phase 1: Validations and Confirmations (Sequential)
    const approvedTools: typeof toolCalls = []
    for (const tc of toolCalls) {
      const toolName = tc.function.name
      const currentMode = getExecutionMode()

      if (!canExecuteTool(toolName)) {
        const denyMsg = getBlockReason(toolName)
        const toolResultJS = { ok: false, error: denyMsg, hint: `Cambia a modo approval o auto con: hivecode mode set approval|auto` }
        const toolResultLLM = formatToolResult(toolResultJS, cleanModel)
        results.push({
          toolResultLLM, id: tc.id, name: toolName, ms: 0,
          sig: toolCallSignature(toolName, tc.function.arguments),
        })
        continue
      }

      if (currentMode === "approval" && !opts.approvedExecution && requiresConfirmation(toolName)) {
        const paramsStr = typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments, null, 2)
        process.stdout.write(`\n[CONFIRMAR] ¿Ejecutar \`${toolName}\`?\n${paramsStr}\n(y/N): `)
        const confirmed = await new Promise<string>(r => process.stdin.once("data", d => r(d.toString().trim().toLowerCase())))
        
        if (confirmed !== "y" && confirmed !== "yes") {
          const toolResultJS = { ok: false, error: `[CANCELADO] Usuario canceló '${toolName}'`, hint: "Ejecución cancelada" }
          results.push({
            toolResultLLM: formatToolResult(toolResultJS, cleanModel), id: tc.id, name: toolName, ms: 0,
            sig: toolCallSignature(toolName, tc.function.arguments),
          })
          continue
        }
      }
      approvedTools.push(tc)
    }

    // Jev decides whether this batch may run concurrently. When it is
    // unavailable it returns null and the sequential-by-default behavior below
    // stands — correctness never depends on the answer, only speed does.
    // ── Checkpoint: pending tool_calls recorded BEFORE execution ────────────
    // A crash between here and the post-tool checkpoint must not re-run these
    // tools on resume: a write that half-ran would happen twice.
    await checkpoint(
      approvedTools.map((tc: typeof toolCalls[number]) => ({ id: tc.id, name: tc.function.name })),
      "pre-tool",
    )

    let runConcurrently = false
    if (approvedTools.length > 1) {
      const jevParallel = await jevWantsParallel(
        approvedTools.map(tc => ({ function: { name: tc.function.name, arguments: tc.function.arguments } })),
      ).catch((err) => {
        log.warn(`[agent-loop] Jev parallel fallback: ${(err as Error).message}`)
        return null
      })
      if (jevParallel) {
        runConcurrently = jevParallel.parallel
        // When the batch cannot be parallelized, the agent is not idle — it is
        // waiting on the oracle. Telling the TUI *why* is the difference between
        // "stuck" and "running serially because two tools touch the same file".
        if (!runConcurrently) {
          emitWaiting({
            agentId: opts.agentId,
            reason: "jev_secuencial",
            taskId: opts.threadId,
          })
        }
        if (jevParallel.decision) {
          log.info(`[agent-loop] Jev parallel=${runConcurrently} calls=${approvedTools.length} (${jevParallel.decision.latencyMs}ms)`)
          emitJevDecision({
            agentId: opts.agentId,
            kind: "parallel",
            provider: provId,
            model: modId,
            summary: `${approvedTools.length} herramientas ${runConcurrently ? "en paralelo" : "en secuencia"}`,
            savedTokens: 0,
            costUsd: jevParallel.decision.costUsd,
            latencyMs: jevParallel.decision.latencyMs,
          })
        }
      }
    }

    // Phase 2: Parallel Execution
    const executeOne = async (tc: typeof approvedTools[number]) => {
      const toolName = tc.function.name
      const tTool = performance.now()
      const toolRuns = await col<ToolRunDoc>("toolRuns")
      const toolRunId = `${runId}:${tc.id}`
      const startedAt = nowSec()
      const argsJson = typeof tc.function.arguments === "string"
        ? tc.function.arguments
        : JSON.stringify(tc.function.arguments)
      try {
        await toolRuns.put(toolRunId, {
          id: toolRunId,
          run_id: runId,
          task_id: opts.threadId,
          tool_name: toolName,
          call_id: tc.id,
          args_json: argsJson,
          result_json: null,
          status: "running",
          read_only: !WORKSPACE_MUTATION_TOOLS.has(toolName) && !DB_MUTATION_TOOLS.has(toolName),
          mutates_workspace: WORKSPACE_MUTATION_TOOLS.has(toolName),
          mutates_db: DB_MUTATION_TOOLS.has(toolName),
          started_at: startedAt,
          completed_at: null,
          duration_ms: null,
          error: null,
        }, { expectedVersion: 0 })
      } catch {
        // Telemetry must not prevent tool execution.
      }
      
      if (opts.onStep) {
        await opts.onStep({ type: "tool_call", toolName, message: `Executing: \`${toolName}\` (parallel)` })
      }

      // ── Telemetría para la TUI ───────────────────────────────────────────
      // `executeOne` es el único camino por el que pasan tanto el lote
      // paralelo como el secuencial, así que es el punto correcto para
      // anunciar la llamada y su cierre. Antes no había nada: el TUI recibía
      // `current_action: "ejecutando <phase>"`, un texto que no decía qué
      // herramienta corría ni cuánto tardar.
      emitToolCall({
        agentId: opts.agentId,
        tool: toolName,
        callId: tc.id,
        argsSummary: summarizeArgs(tc.function.arguments),
        taskId: opts.threadId,
      })

      opts.signal?.throwIfAborted()
      const toolResultJS = await executeTool(ctx.allTools, toolName, tc.function.arguments, {
        signal: opts.signal,
        user_id: opts.userId,
        thread_id: opts.threadId,
        channel: opts.channel,
        workspace: agent.workspace ?? null,
        // Delegation reads these: a worker inherits the parent's run and approval.
        agent_id: opts.agentId,
        run_id: runId,
        approved_execution: opts.approvedExecution === true,
      })
      
      const toolMs = Math.round(performance.now() - tTool)
      // One result never gets to take the window: an fs_list of a whole repo used
      // to go in whole and the next call died with a 400.
      const toolResultLLM = capToolResult(formatToolResult(toolResultJS, cleanModel), providerCfg.contextWindow)
      const toolError = !!(
        toolResultJS
        && typeof toolResultJS === "object"
        && "error" in toolResultJS
        && (toolResultJS as any).error
      )

      emitToolDone({
        agentId: opts.agentId,
        tool: toolName,
        callId: tc.id,
        ok: !toolError,
        durationMs: toolMs,
        resultSummary: summarizeArgs(toolResultLLM),
        taskId: opts.threadId,
      })

      // G9: the tool call and its outcome, chained to the decision that asked
      // for it. toolStats() reads these back as whole-history aggregates.
      if (causalDb) {
        const outcome = toolError
          ? { Err: toolResultLLM.slice(0, 300) }
          : "Ok"
        await appendCausalEvent(causalDb, {
          agentId: opts.agentId,
          streamId: causalStreamId,
          kind: "ToolCall",
          payload: { tool: toolName, latency_ms: toolMs, outcome },
          causation: lastCausalSeq,
          correlation: causalCorrelationId,
        })
      }
      try {
        const recorded = await toolRuns.get(toolRunId)
        if (recorded) {
          await toolRuns.put(toolRunId, {
            ...recorded.doc,
            result_json: JSON.stringify(toolResultJS),
            status: toolError ? "failed" : "completed",
            completed_at: nowSec(),
            duration_ms: toolMs,
            error: toolError ? String((toolResultJS as any).error) : null,
          }, { expectedVersion: recorded.version })
        }
      } catch {
        // Telemetry must not affect the agent result.
      }
      
      const sig = toolCallSignature(toolName, tc.function.arguments)
      return {
        toolResultLLM,
        toolResultJS,
        id: tc.id,
        name: toolName,
        ms: toolMs,
        sig,
        argsJson: typeof tc.function.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments ?? {}),
      }
    }

    // Result order follows tool-call order regardless of execution order, so the
    // transcript reads the same whether or not the batch was parallelized.
    let parallelResults: Awaited<ReturnType<typeof executeOne>>[]
    if (runConcurrently) {
      parallelResults = await Promise.all(approvedTools.map(executeOne))
    } else {
      // Sequential by default: an unproven batch is a batch that can interleave
      // two writers over the same file.
      const collected: typeof parallelResults = []
      for (const tc of approvedTools) collected.push(await executeOne(tc))
      parallelResults = collected
    }
    results.push(...parallelResults)

    // Phase 3: Post-execution (Traces, yielding, state updates)
    for (const r of results) {
      log.info(`[agent-loop] Tool ${r.name} completed in ${r.ms}ms`)
      
      saveTrace({
        threadId: opts.threadId,
        agentId: opts.agentId,
        agentName,
        toolUsed: r.name,
        inputSummary: `Parallel Execution: ${r.name}`,
        outputSummary: r.toolResultLLM.substring(0, 300),
        success: !r.toolResultLLM.startsWith("[Tool Error]"),
        errorMessage: r.toolResultLLM.startsWith("[Tool Error]") ? r.toolResultLLM : null,
        durationMs: r.ms,
        causalStreamId: causalDb ? causalStreamId : null,
        runEpoch: runEpochKey,
      })

      // Loop detection runs before the result is handed back, so a corrective note can
      // ride along inside the tool result the model is about to read.
      const verdict = repeats.record(r.name, r.sig)
      let resultContent = r.toolResultLLM
      if (verdict === "nudge") {
        const repeatCount = repeats.countFor(r.sig)
        const streak = repeats.streakFor(r.name)
        resultContent += `\n\n[AVISO DEL HARNESS] Ya llamaste \`${r.name}\``
          + (repeatCount > 1 ? ` ${repeatCount} veces con estos mismos argumentos` : ` ${streak} veces seguidas`)
          + ` y el objetivo no avanzó. No repitas esta llamada: cambia de enfoque, usa otra`
          + ` herramienta, o responde al usuario con lo que tengas.`
        log.warn(`[agent-loop] Repeat nudge: "${r.name}" repeat=${repeatCount} streak=${streak}`)
      } else if (verdict === "stop") {
        log.warn(`[agent-loop] Loop detected: "${r.name}" repeat=${repeats.countFor(r.sig)} streak=${repeats.streakFor(r.name)}. Breaking.`)
        runStatus = "blocked"
        blocker = `repeated_tool_call:${r.name}`
        // Flag only — the remaining results still need to be appended so the assistant
        // message's tool_calls all have their matching tool replies. Breaking here would
        // leave the history invalid.
        loopDetected = true
      }

      // Stuck / stall detection runs on every result, including the ones the
      // RepeatTracker already flagged: a retry loop that keeps failing is a
      // different diagnosis from a repeated call, and the intervention text
      // differs.
      stuckDetector.recordToolCall(
        runId,
        r.name,
        toArgsRecord(r.argsJson),
        r.toolResultLLM.startsWith("[Tool Error]") ? r.toolResultLLM.slice(0, 300) : undefined,
      )
      const stuck = stuckDetector.check(runId)
      if (stuck.detected && resultContent === r.toolResultLLM) {
        // Only speak up once: the RepeatTracker may already have said something,
        // and two warnings in one tool result is noise the model has to read.
        const intervention = getInterventionMessage(stuck)
        if (intervention) {
          resultContent += `\n\n[AVISO DEL HARNESS] ${intervention}`
          log.warn(`[agent-loop] Stuck ${stuck.kind}: ${stuck.toolName} x${stuck.count}`)
        }
      }

      // Progress fingerprint: what the run has achieved, not what it has said.
      // A transcript hash would move every turn by construction and never
      // register a stall.
      stuckDetector.recordProgress(runId, progressFingerprint(messages))

      yield { tools: { messages: [{ content: resultContent, tool_call_id: r.id }] } }
      if (opts.onStep) await opts.onStep({ type: "tool_result", message: resultContent })

      messages.push({ role: "tool", content: resultContent, tool_call_id: r.id })
      if (!opts.isolated) {
        await addMessage(opts.threadId, "tool", resultContent, {
          channel: opts.channel,
          tool_call_id: r.id,
        })
      }
      // Dynamic tool injection: when search_knowledge finds tools, add them to ctx.tools
      if (r.name === "search_knowledge") {
        try {
          const result = r.toolResultJS as any
          const foundTools: Array<{ name: string }> = result?.tools ?? []
          const foundMcpTools: Array<{ tool_name: string; full_name?: string; id?: string }> = result?.toolsmcp ?? []
          const currentToolNames = new Set(ctx.tools.map((t: any) => t.function?.name))
          const injectedTools: string[] = []

          for (const found of foundTools) {
            if (!currentToolNames.has(found.name)) {
              const nativeTool = ctx.allTools.find(t => t.name === found.name)
              if (nativeTool) {
                ctx.tools.push({
                  type: "function",
                  function: {
                    name: nativeTool.name,
                    description: (nativeTool as any).description ?? "",
                    parameters: (nativeTool as any).parameters ?? { type: "object", properties: {} },
                  },
                })
                log.info(`[agent-loop] Injected discovered native tool into loadout: ${nativeTool.name}`)
                currentToolNames.add(found.name)
                injectedTools.push(nativeTool.name)
              }
            }
          }

          for (const found of foundMcpTools) {
            const mcpFullName = found.full_name || found.id
            log.debug(`[agent-loop] MCP discovery candidate: tool_name="${found.tool_name}", full_name="${found.full_name}", id="${found.id}", resolved="${mcpFullName}"`)
            if (!currentToolNames.has(mcpFullName)) {
              const mcpTool = ctx.allTools.find(t => t.name === mcpFullName)
              if (mcpTool) {
                ctx.tools.push({
                  type: "function",
                  function: {
                    name: mcpTool.name,
                    description: (mcpTool as any).description ?? "",
                    parameters: (mcpTool as any).parameters ?? { type: "object", properties: {} },
                  },
                })
                log.info(`[agent-loop] Injected discovered MCP tool into loadout: ${mcpTool.name}`)
                currentToolNames.add(mcpFullName)
              } else {
                log.warn(`[agent-loop] MCP tool "${mcpFullName}" not found in allTools (available MCP: ${ctx.allTools.filter(t => t.name.includes('__')).map(t => t.name).join(', ')})`)
              }
            }
          }

          if (injectedTools.length > 0) {
            try {
              const skillsCol = await col<SkillDoc>("skills")
              const skillsWithTools = (await skillsCol.scan({}))
                .map(e => e.doc)
                .filter(s => s.active && injectedTools.some(t => s.tools.includes(t)))
                .map(s => ({ name: s.name, body: s.body, tools: s.tools }))

              const matchingSkills = skillsWithTools.filter(s => {
                const skillTools = s.tools?.split(",").map(t => t.trim()) ?? []
                return injectedTools.some(injected => skillTools.includes(injected))
              })

              if (matchingSkills.length > 0) {
                const systemMsg = messages.find(m => m.role === "system")
                if (systemMsg && typeof systemMsg.content === "string") {
                  const existingSkillNames = new Set(
                    (systemMsg.content.match(/## Skill: ([^\n]+)/g) || [])
                      .map(m => m.replace("## Skill: ", "").trim())
                  )
                  const newSkills = matchingSkills.filter(s => !existingSkillNames.has(s.name))
                  if (newSkills.length > 0) {
                    const newSkillSection = newSkills
                      .map(s => `## Skill: ${s.name}\n${s.body}`)
                      .join("\n\n")
                    systemMsg.content += `\n\n--- SKILL INSTRUCTIONS (Auto-loaded) ---\n${newSkillSection}`
                    log.info(`[agent-loop] Injected ${newSkills.length} skill(s) for tools: ${newSkills.map(s => s.name).join(", ")}`)
                  }
                }
              }
            } catch (skillErr) {
              log.warn(`[agent-loop] Failed to inject skills for tools: ${(skillErr as Error).message}`)
            }
          }
        } catch (err) {
          log.warn(`[agent-loop] search_knowledge tool injection failed: ${(err as Error).message}`)
        }

        try {
          const result = r.toolResultJS as any
          const foundSkills: Array<{ name: string; body?: string }> = result?.skills ?? []
          const foundPlaybook: Array<{ rule: string; category?: string }> = result?.playbook ?? []

          if (foundSkills.length > 0 || foundPlaybook.length > 0) {
            const extras: string[] = []

            if (foundSkills.some((s: any) => s.body)) {
              const section = foundSkills
                .filter((s: any) => s.body)
                .map((s: any) => `## Skill: ${s.name}\n${s.body}`)
                .join("\n\n")
              extras.push(`\n\n--- SKILL INSTRUCTIONS ---\n${section}`)
            }

            if (foundPlaybook.length > 0) {
              const section = foundPlaybook.map((p: any) => `- [${p.category ?? "general"}] ${p.rule}`).join("\n")
              extras.push(`\n\n--- PLAYBOOK RULES ---\n${section}`)
            }

            if (extras.length > 0) {
              const lastMsg = messages[messages.length - 1]
              if (lastMsg?.role === "tool") {
                lastMsg.content += extras.join("")
                log.info(`[agent-loop] Enriched search_knowledge result with ${foundSkills.length} skill(s) and ${foundPlaybook.length} rule(s)`)
              }
            }
          }
        } catch (err) {
          log.warn(`[agent-loop] search_knowledge enrichment failed: ${(err as Error).message}`)
        }
      }

    }

    // ── Checkpoint: tools completed, pending cleared ──────────────────────
    // The history now includes every tool result, so a resume from here picks
    // up at the next model call with nothing left in flight.
    await checkpoint([], "post-tool")

    // A stalled run still gets the synthesis pass below, so the user receives a summary
    // of what was actually done instead of a bare "blocked".
    if (loopDetected) break
  }

  if (finalContent && !finalContentEmitted) {
    if (!opts.isolated) {
      await addMessage(opts.threadId, "assistant", finalContent)
    }
    yield { agent: { messages: [{ content: finalContent }] } }
    finalContentEmitted = true
  }

  if (!finalContent && iterations >= maxSteps) {
    runStatus = "needs_budget"
    blocker = `max_steps:${maxSteps}`
  }

  // ── Synthesis call when the harness stops without a text response ─────────
  // The agent spent all iterations on tool calls and never produced a final message.
  // Make one extra call without tools so it summarizes the current state.
  if (!finalContent) {
    log.info(`[agent-loop] Harness stopped without text response — requesting synthesis (isolated=${!!opts.isolated}, status=${runStatus})`)
    try {
      messages.push({
        role: "user",
        content: "Basándote en lo que hiciste hasta ahora, responde al usuario con un resumen claro del estado actual. Si el objetivo no está completo, dilo explícitamente y explica el bloqueo o el siguiente paso. Sé conciso.",
      })
      const synthesis = await callProfileLLM({
        ...providerCfg,
        ...profileCallOptions,
        messages: prepareMessages(messages, undefined),
        tools: undefined, // no tools — force text response
        signal: opts.signal,
        onToken: opts.onToken,
      })
      if (synthesis.usage) {
        totalInputTokens += synthesis.usage.input_tokens
        totalOutputTokens += synthesis.usage.output_tokens
        totalCostUsd += (
          synthesis.usage.input_tokens + synthesis.usage.output_tokens
        ) * getAverageTokenCost(providerCfg.model)
      }
      finalContent = synthesis.content?.trim() || "No pude completar el objetivo dentro del presupuesto de pasos disponible."
      if (!opts.isolated) {
        await addMessage(opts.threadId, "assistant", finalContent)
      }
      yield { agent: { messages: [{ content: finalContent }] } }
    } catch (err) {
      log.warn(`[agent-loop] Synthesis call failed: ${(err as Error).message}`)
      finalContent = "No pude completar el objetivo dentro del presupuesto de pasos disponible."
      if (runStatus === "running") runStatus = "failed"
      blocker = blocker || (err as Error).message
      if (!opts.isolated) {
        await addMessage(opts.threadId, "assistant", finalContent)
      }
      yield { agent: { messages: [{ content: finalContent }] } }
    }
  }

  // Emit final usage so consumers (e.g. AgentRunner) can surface real token counts
  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    yield { usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens } }
  }

  // ── Post-loop ────────────────────────────────────────────────────────────
  const durationMs = Math.round(performance.now() - t0)

  // Record usage
  recordLLMUsage({
    provider: providerCfg.provider,
    model: providerCfg.model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  })

  // Extract text for trace summary
  const textMessageFinal = opts.rawUserMessage || textFromMessage(opts.userMessage)

  // Save overall trace
  const cleanMessageFinal = textMessageFinal.replace(/^\[Timestamp:.*?\]\n/, "")
  saveTrace({
    threadId: opts.threadId,
    agentId: opts.agentId,
    agentName,
    inputSummary: cleanMessageFinal.substring(0, 300),
    outputSummary: finalContent.substring(0, 300),
    success: runStatus === "completed",
    durationMs,
    tokensUsed: totalInputTokens + totalOutputTokens,
    runEpoch: runEpochKey,
  })

  log.info(
    `[agent-loop] Done: run=${runId} status=${runStatus} agent=${agentName} iterations=${iterations} ` +
    `tokens=${totalInputTokens + totalOutputTokens} elapsed=${durationMs}ms`
  )

  await updateRun({
    status: runStatus,
    turn: iterations,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cost_usd: totalCostUsd,
    blocker,
    // A run that stopped short of its goal and left a checkpoint is resumable;
    // one that completed or exhausted its budget is not, whatever the reason.
    next_action: runStatus === "completed" ? null : "resume_or_increase_budget",
    handoff_json: JSON.stringify({
      status: runStatus,
      summary: finalContent,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cost_usd: totalCostUsd,
      blocker,
      resumable: isResumable,
    }),
    completed_at: nowSec(),
  })
  yield { run: { status: runStatus, blocker } }

  // Last line of defense. The body above can throw, and a consumer can abandon
  // the generator without draining it — in both cases the run would be left
  // reading "running" with a live lease, which is exactly what makes
  // adaptive-scheduler reclaim it out from under nothing.
  } finally {
    stopLeaseRenewal()
    if (runStatus === "running") {
      runStatus = "interrupted"
      await updateRun({
        status: "interrupted",
        next_action: "resume",
        blocker: blocker ?? "loop_abandoned",
      }).catch(() => { /* the row may already be gone */ })
    }
  }
}

// ─── Isolated worker execution (Fase 4.4) ───────────────────────────────────

/**
 * Statuses that are a partial result rather than a failure.
 *
 * The loop always makes a tool-less synthesis call before it gives up, so a run that
 * exhausted its budget or stalled still carries a usable summary of what it did.
 * Throwing that away turned "the agent ran out of steps" into "the whole task failed".
 */
const PARTIAL_RESULT_STATUSES = new Set<AgentRunStatus>(["needs_budget", "blocked"])

/**
 * Run a worker agent in an isolated context.
 * Returns the final response string.
 */
export async function runAgentIsolated(opts: {
  agentId: string
  taskDescription: string | ContentPart[]
  threadId: string
  mcpManager?: MCPClientManager | null
  parentRunId?: string
  runKind?: AgentRunDoc["kind"]
  approvedExecution?: boolean
  onStep?: (step: StepEvent) => Promise<void>
  maxSteps?: number
  signal?: AbortSignal
  onToken?: (token: string) => void
  onReasoningToken?: (token: string) => void
}): Promise<string> {
  let lastContent = ""
  let finalRun: StreamChunk["run"]
  for await (const chunk of runAgent({
    agentId: opts.agentId,
    userMessage: opts.taskDescription,
    threadId: opts.threadId,
    isolated: true,
    taskContext: opts.taskDescription,
    mcpManager: opts.mcpManager,
    parentRunId: opts.parentRunId,
    runKind: opts.runKind,
    approvedExecution: opts.approvedExecution,
    onStep: opts.onStep,
    maxSteps: opts.maxSteps,
    signal: opts.signal,
    onToken: opts.onToken,
    onReasoningToken: opts.onReasoningToken,
  })) {
    if (chunk.agent?.messages?.[0]?.content) {
      lastContent = chunk.agent.messages[0].content
    }
    if (chunk.run) finalRun = chunk.run
  }
  if (finalRun && finalRun.status !== "completed") {
    const summary = lastContent.trim()
    // Budget exhaustion and stalls are degraded outcomes, not failures — return the
    // synthesis summary and let the caller decide. The real status and blocker stay
    // recorded on the agentRuns row, so observability is unaffected.
    if (PARTIAL_RESULT_STATUSES.has(finalRun.status) && summary) {
      log.warn(
        `[agent-loop] Agent ${opts.agentId} returned a partial result: ${finalRun.status}` +
        (finalRun.blocker ? ` (${finalRun.blocker})` : ""),
      )
      return summary
    }
    throw new Error(
      `Agent ${opts.agentId} ended with ${finalRun.status}` +
      (finalRun.blocker ? `: ${finalRun.blocker}` : ""),
    )
  }
  return lastContent
}

// ─── Shim: AgentLoop class with stream() compatible with providers/index.ts ──

export class AgentLoop {
  private mcpManager: MCPClientManager | null = null

  setMCPManager(m: MCPClientManager) {
    this.mcpManager = m
  }

  /**
   * Returns an async iterable that emits chunks compatible with
   * the existing providers/index.ts stream consumer.
   */
  stream(
    input: { messages: Array<{ role: string; content: string | ContentPart[] }> },
    config: {
      configurable?: {
        thread_id?: string
        agent_id?: string
        user_id?: string
        system_prompt?: string
        channel?: string
        raw_user_message?: string
      }
      signal?: AbortSignal
      /** Per-run step ceiling. Without this the caller's budget never reaches runAgent. */
      maxSteps?: number
      /** Answer tokens as they arrive — drives `assistant_chunk` on the IPC bus. */
      onToken?: (token: string) => void
      /** Reasoning tokens as they arrive — drives `thought_chunk`. */
      onReasoningToken?: (token: string) => void
    }
  ): AsyncIterable<StreamChunk> {
    // Resolve from database with priority: explicit param → DB lookup → single user/agent
    const threadId = config.configurable?.thread_id || "default"
    const agentId = config.configurable?.agent_id || "main"
    const systemPromptOverride = config.configurable?.system_prompt
    const channel = config.configurable?.channel
    const userId = config.configurable?.user_id || "default"

    // Log MCP Manager status
    log.info(`[AgentLoop.stream] MCP Manager available: ${this.mcpManager !== null}`)
    if (this.mcpManager) {
      try {
        const servers = this.mcpManager.listServers?.() || []
        log.info(`[AgentLoop.stream] MCP servers: ${servers.length} registered`)
        for (const s of servers) {
          log.info(`  - ${s.name}: ${s.status} (${s.tools?.length || 0} tools)`)
        }
      } catch (e) {
        log.warn(`[AgentLoop.stream] Failed to list MCP servers: ${(e as Error).message}`)
      }
    }

    // Extract the last user message from the input
    const lastUserMsg = [...input.messages].reverse().find((m) => m.role === "user")
    const userMessage = lastUserMsg?.content || ""

    // Use clean message (without timestamp) for selectors/tracing
    const rawUserMessage = config.configurable?.raw_user_message || 
      (typeof userMessage === "string" ? userMessage : userMessage.filter(p => p.type === "text").map(p => (p as any).text).join("\n"))

    return runAgent({
      agentId,
      userMessage, // FULL MULTIMODAL MESSAGE
      rawUserMessage, // CLEAN TEXT for selectors/tracing
      threadId,
      channel,
      systemPromptOverride,
      mcpManager: this.mcpManager,
      userId,
      maxSteps: config.maxSteps,
      signal: config.signal,
      onToken: config.onToken,
      onReasoningToken: config.onReasoningToken,
    })
  }

  private _resolveCoordinatorId(): string {
    return "main";
  }
}

// Singleton
let _agentLoop: AgentLoop | null = null

export function getAgentLoop(): AgentLoop | null {
  return _agentLoop
}

export function buildAgentLoop(opts: { mcpManager?: MCPClientManager | null } = {}): AgentLoop {
  _agentLoop = new AgentLoop()
  if (opts.mcpManager) {
    _agentLoop.setMCPManager(opts.mcpManager)
    log.info("[buildAgentLoop] MCP Manager set successfully")
  } else {
    log.warn("[buildAgentLoop] No MCP Manager provided, agent will not have MCP tools")
  }
  return _agentLoop
}

export async function rebuildAgentLoop(opts: { mcpManager?: MCPClientManager | null } = {}): Promise<AgentLoop> {
  _agentLoop = null
  return buildAgentLoop(opts)
}
