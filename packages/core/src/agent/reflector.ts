/**
 * ACE Reflector — analyzes recent traces and produces insights.
 *
 * Runs in the background (never blocks the main agent loop).
 * Output goes to the HiveDB `reflections` collection and is picked up by Curator.
 */

import { col, nextId } from "../storage/hive"
import type { CursorDoc, ReflectionDoc, TraceDoc } from "../storage/collections"
import { getHiveDb } from "../storage/hivedb"
import { causalLogEnabled } from "../storage/causal-events"
import { logger } from "../utils/logger"
import type { HiveDB } from "@johpaz/hive-db"
import { commonEpochKey, distinctEpochKeys } from "./run-epoch"

/**
 * How much to discount an insight whose batch spans more than one epoch.
 * Deliberately not zero: the boundary is a reason for suspicion, not proof that
 * the pattern is an artifact.
 */
const EPOCH_STRADDLE_PENALTY = 0.6

const log = logger.child("reflector")

const MAX_TRACES_TO_ANALYZE = 30
const MIN_TRACES_TO_RUN = 10
const CURSOR_ID = "reflector:lastTrace"

export async function runReflector(): Promise<void> {
  try {
    log.info("[reflector] Starting reflection cycle...")

    const cursors = await col<CursorDoc>("cursors")
    const cursorEntry = await cursors.get(CURSOR_ID)
    const lastProcessedId = cursorEntry?.doc.value ?? null

    const traces = await col<TraceDoc>("traces")
    let candidates = lastProcessedId
      ? await traces.scan({ start: lastProcessedId })
      : await traces.scan({})
    if (lastProcessedId && candidates[0]?.id === lastProcessedId) candidates = candidates.slice(1)

    const traceEntries = candidates.slice(0, MAX_TRACES_TO_ANALYZE)
    const traceDocs = traceEntries.map((entry) => entry.doc)
    log.debug(`[reflector] Fetched ${traceDocs.length} traces`)

    if (traceDocs.length < MIN_TRACES_TO_RUN) {
      log.debug(`[reflector] Not enough traces (${traceDocs.length}/${MIN_TRACES_TO_RUN}), skipping`)
      return
    }

    const causalDb = causalLogEnabled() ? await getHiveDb() : null
    const insights = await analyzeTracesLocally(traceDocs, causalDb)
    // G9: alongside the local heuristics, evaluate the causal thread of each
    // stream this batch touched. Needs a full decision chain per run, so it is
    // strictly additional signal — never a replacement.
    const causalInsights = await analyzeCausalThreads(traceDocs, causalDb)
    insights.push(...causalInsights)

    if (insights.length > 0) {
      const reflections = await col<ReflectionDoc>("reflections")
      const traceIds = JSON.stringify(traceEntries.map((entry) => entry.id))
      for (const insight of insights) {
        const id = await nextId("reflections")
        await reflections.put(id, {
          id,
          trace_ids: traceIds,
          insight_type: insight.type,
          description: insight.description,
          affected_tools: insight.affectedTools ? JSON.stringify(insight.affectedTools) : null,
          affected_agents: insight.affectedAgents ? JSON.stringify(insight.affectedAgents) : null,
          confidence: insight.confidence,
          created_at: Date.now(),
        }, { expectedVersion: 0 })
      }
      log.info(`[reflector] Generated ${insights.length} insights`)
    }

    const newCursor = traceEntries[traceEntries.length - 1].id
    await cursors.put(CURSOR_ID, { value: newCursor, updated_at: Date.now() }, { expectedVersion: cursorEntry?.version ?? 0 })

    const { runCurator } = await import("./curator")
    await runCurator()
    log.info("[reflector] Reflection cycle completed successfully")
  } catch (err) {
    log.error("[reflector] Error during reflection:", {
      message: (err as Error).message,
      stack: (err as Error).stack,
    })
  }
}

interface Insight {
  type: "success_pattern" | "failure_pattern" | "optimization" | "ethics_violation" | "root_cause" | "learning_proposal"
  description: string
  affectedTools?: string[]
  affectedAgents?: string[]
  confidence: number
}

// ─── G9 causal-thread analysis (evaluateHarness) ──────────────────────────────

interface DecisionNode {
  seq: number
  agent: string
  description: string
}

interface CausalThreadShape {
  decisions: DecisionNode[]
  toolCalls: Array<{ seq: number; agent: string; tool: string }>
  anomalies: unknown[]
}

interface ToolStats {
  invocations: number
  errors: number
  totalLatencyMs: number
}

interface HarnessEvaluationShape {
  processQuality: number
  outputQuality: number
  rootCause?: { seq: number; agent: string }
  findings: Array<{ kind: string; seq?: number; description: string }>
  proposals: Array<{ description: string; confidence: number }>
}

/**
 * Evaluate every distinct G9 stream this batch of traces touched with HiveDB's
 * harness loop, turning its root cause, findings and learning proposals into
 * reflector insights.
 */
async function analyzeCausalThreads(traces: TraceDoc[], causalDb: HiveDB | null): Promise<Insight[]> {
  if (!causalDb) return []

  const insights: Insight[] = []
  const streamIds = new Set(traces.map((t) => t.causal_stream_id).filter((s): s is string => !!s))

  for (const streamId of streamIds) {
    try {
      const thread = (await causalDb.causalThread(streamId)) as CausalThreadShape
      if (!thread.decisions?.length && !thread.toolCalls?.length) continue

      const subset = traces.filter((t) => t.causal_stream_id === streamId)
      const originalIntent = subset[0]?.input_summary ?? ""
      const success = subset.every((t) => t.success)

      const evaluation = (await causalDb.evaluateHarness({
        causalThread: thread,
        similarEpisodes: [],
        originalIntent,
        currentState: { success },
        minConfidence: 0.5,
      })) as HarnessEvaluationShape

      // The description deliberately omits streamId/seq: the curator only
      // reinforces an existing rule when its first-60-chars prefix matches
      // exactly, so any per-run identifier in the text would make every
      // occurrence of the same underlying root cause mint a brand new playbook
      // rule instead of reinforcing one.
      if (evaluation.rootCause) {
        const decision = thread.decisions?.find((d) => d.seq === evaluation.rootCause!.seq)
        insights.push({
          type: "root_cause",
          description: decision
            ? `Root cause: decision "${decision.description}" (agent ${evaluation.rootCause.agent}) preceded a tool failure.`
            : `Root cause: a decision by agent ${evaluation.rootCause.agent} preceded a tool failure.`,
          affectedAgents: [evaluation.rootCause.agent],
          confidence: 0.6,
        })
      }

      // Only inefficientLoop findings: harness.rs's find_root_cause() always emits
      // rootCause together with an equivalent finding{kind:"rootCause"} from the
      // same resolution, so taking both would double-insight every failure. The
      // block above covers it with a richer description.
      for (const finding of evaluation.findings ?? []) {
        if (finding.kind === "inefficientLoop") {
          insights.push({ type: "root_cause", description: finding.description, confidence: 0.6 })
        }
      }

      for (const proposal of evaluation.proposals ?? []) {
        insights.push({ type: "learning_proposal", description: proposal.description, confidence: proposal.confidence })
      }
    } catch (err) {
      log.warn(`[reflector] Causal-thread analysis failed for stream ${streamId}: ${(err as Error).message}`)
    }
  }

  return insights
}

/**
 * Local heuristics over the recent trace batch. Whole-history aggregates from
 * HiveDB's event log are added by analyzeCausalThreads() / the toolStats pass —
 * a batch of 30 traces says what happened recently, the log says what is true.
 */
async function analyzeTracesLocally(traces: TraceDoc[], causalDb: HiveDB | null = null): Promise<Insight[]> {
  const insights: Insight[] = []

  // Requalification boundary. A batch that spans two epochs — a model swap, a
  // deploy, a tool catalog that gained or lost an entry — cannot support
  // "this tool has been failing lately", because the two halves ran under
  // different conditions. Every insight below is scaled down rather than
  // discarded: the signal may still be real, it just cannot be trusted at the
  // confidence a single-epoch batch would earn.
  const epochs = traces.map(t => t.run_epoch ?? null)
  const uniformEpoch = commonEpochKey(epochs)
  const straddlesBoundary = distinctEpochKeys(epochs).length > 1 || (uniformEpoch === undefined && epochs.some(Boolean))
  if (straddlesBoundary) {
    log.info(
      `[reflector] Batch spans a requalification boundary (${distinctEpochKeys(epochs).length} epochs); ` +
      `insight confidence scaled by ${EPOCH_STRADDLE_PENALTY}`,
    )
  }
  const scale = (confidence: number): number =>
    straddlesBoundary ? confidence * EPOCH_STRADDLE_PENALTY : confidence

  // G9 whole-history stats per tool touched by this batch (undefined when the
  // causal log is off, or when the tool has no events yet). These replace the
  // batch counters below wherever they exist: a 30-trace batch says what
  // happened recently, the event log says what is true about the tool.
  const statsByTool = new Map<string, ToolStats>()
  if (causalDb) {
    const distinctTools = new Set(traces.map((t) => t.tool_used).filter((t): t is string => !!t))
    for (const tool of distinctTools) {
      try {
        const stats = await causalDb.toolStats(tool)
        if (stats) statsByTool.set(tool, stats as ToolStats)
      } catch (err) {
        log.warn(`[reflector] toolStats(${tool}) failed: ${(err as Error).message}`)
      }
    }
  }

  const failures = traces.filter((trace) => !trace.success)
  if (failures.length > 3) {
    const toolFailures: Record<string, number> = {}
    for (const failure of failures) {
      if (failure.tool_used) toolFailures[failure.tool_used] = (toolFailures[failure.tool_used] || 0) + 1
    }
    for (const [tool, batchCount] of Object.entries(toolFailures)) {
      const count = statsByTool.get(tool)?.errors ?? batchCount
      if (count >= 3) {
        insights.push({
          type: "failure_pattern",
          description: `Tool '${tool}' failed ${count} times recently. Consider verifying its configuration or avoiding it for this type of task.`,
          affectedTools: [tool],
          confidence: scale(Math.min(0.9, count / 10)),
        })
      }
    }
  }

  const slowThresholdMs = 5000
  const slowTools: Record<string, number[]> = {}
  for (const trace of traces) {
    if (trace.tool_used && (trace.duration_ms ?? 0) > slowThresholdMs) {
      slowTools[trace.tool_used] ??= []
      slowTools[trace.tool_used].push(trace.duration_ms!)
    }
  }
  for (const [tool, durations] of Object.entries(slowTools)) {
    if (durations.length >= 3) {
      const stats = statsByTool.get(tool)
      const avg = stats && stats.invocations > 0
        ? Math.round(stats.totalLatencyMs / stats.invocations)
        : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      insights.push({
        type: "optimization",
        description: `Tool '${tool}' is consistently slow (avg ${avg}ms). Cache results when possible or use a faster alternative.`,
        affectedTools: [tool],
        confidence: scale(0.6),
      })
    }
  }

  const successByTool: Record<string, { ok: number; total: number }> = {}
  for (const trace of traces) {
    if (!trace.tool_used) continue
    successByTool[trace.tool_used] ??= { ok: 0, total: 0 }
    successByTool[trace.tool_used].total++
    if (trace.success) successByTool[trace.tool_used].ok++
  }
  for (const [tool, stats] of Object.entries(successByTool)) {
    if (stats.total >= 5 && stats.ok / stats.total >= 0.9) {
      insights.push({
        type: "success_pattern",
        description: `Tool '${tool}' has a high success rate (${stats.ok}/${stats.total}). Prefer it for related tasks.`,
        affectedTools: [tool],
        confidence: scale( stats.ok / stats.total,)
      })
    }
  }

  const highTokenTraces = traces.filter((trace) => (trace.tokens_used ?? 0) > 4000)
  if (highTokenTraces.length > 3) {
    insights.push({
      type: "optimization",
      description: `${highTokenTraces.length} recent calls used >4000 tokens. Be more concise and use tool results as summaries, not raw dumps.`,
      confidence: scale( 0.7,)
    })
  }

  return insights
}
