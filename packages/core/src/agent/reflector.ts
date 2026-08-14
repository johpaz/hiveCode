/**
 * ACE Reflector — analyzes recent traces and produces insights.
 *
 * Runs in the background (never blocks the main agent loop).
 * Output goes to the HiveDB `reflections` collection and is picked up by Curator.
 */

import { col, nextId } from "../storage/hive"
import type { CursorDoc, ReflectionDoc, TraceDoc } from "../storage/collections"
import { logger } from "../utils/logger"

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

    const insights = analyzeTracesLocally(traceDocs)
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
  type: "success_pattern" | "failure_pattern" | "optimization" | "ethics_violation"
  description: string
  affectedTools?: string[]
  affectedAgents?: string[]
  confidence: number
}

function analyzeTracesLocally(traces: TraceDoc[]): Insight[] {
  const insights: Insight[] = []

  const failures = traces.filter((trace) => !trace.success)
  if (failures.length > 3) {
    const toolFailures: Record<string, number> = {}
    for (const failure of failures) {
      if (failure.tool_used) toolFailures[failure.tool_used] = (toolFailures[failure.tool_used] || 0) + 1
    }
    for (const [tool, count] of Object.entries(toolFailures)) {
      if (count >= 3) {
        insights.push({
          type: "failure_pattern",
          description: `Tool '${tool}' failed ${count} times recently. Consider verifying its configuration or avoiding it for this type of task.`,
          affectedTools: [tool],
          confidence: Math.min(0.9, count / 10),
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
      const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      insights.push({
        type: "optimization",
        description: `Tool '${tool}' is consistently slow (avg ${avg}ms). Cache results when possible or use a faster alternative.`,
        affectedTools: [tool],
        confidence: 0.6,
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
        confidence: stats.ok / stats.total,
      })
    }
  }

  const highTokenTraces = traces.filter((trace) => (trace.tokens_used ?? 0) > 4000)
  if (highTokenTraces.length > 3) {
    insights.push({
      type: "optimization",
      description: `${highTokenTraces.length} recent calls used >4000 tokens. Be more concise and use tool results as summaries, not raw dumps.`,
      confidence: 0.7,
    })
  }

  return insights
}
