import { col, ensureIndexes } from "../storage/hive"
import type { AgentRunDoc } from "../storage/collections"

/** Sum a parent and every descendant, including retired ephemeral executors. */
export async function getSwarmUsage(rootRunId: string): Promise<{
  runs: number; inputTokens: number; outputTokens: number; costUsd: number; estimatedInputTokens: number
}> {
  await ensureIndexes([["agentRuns", "parent_run_id"]])
  const runs = await col<AgentRunDoc>("agentRuns")
  const seen = new Set<string>()
  const pending = [rootRunId]
  const total = {runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedInputTokens: 0}
  while (pending.length) {
    const id = pending.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const run = (await runs.get(id))?.doc
    if (run) {
      total.runs++
      total.inputTokens += run.input_tokens || 0
      total.outputTokens += run.output_tokens || 0
      total.costUsd += run.cost_usd || 0
      try { total.estimatedInputTokens += JSON.parse(run.context_metrics_json || "{}").estimated_input_tokens || 0 } catch { /* old run */ }
    }
    pending.push(...(await runs.findBy("parent_run_id", id)).map(row => row.doc.id))
  }
  return total
}
