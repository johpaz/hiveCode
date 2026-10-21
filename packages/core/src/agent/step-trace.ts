import { appendFileSync } from "node:fs"

/**
 * One line per model call, for judging a run step by step: how long the model took, what it
 * read and wrote, and which tools it asked for. Off unless `HIVE_STEP_LOG=<file>` is set.
 *
 * The run record keeps only totals, so a run of 99 K output tokens cannot say whether they were
 * one long file, a rewrite, or the model thinking. This can.
 */
export interface StepTrace {
  agent: string
  turn: number
  /** Wall-clock of the model call alone, tools excluded. */
  ms: number
  /** The `reasoning_effort` this turn asked for, or null when none was sent. */
  reasoningEffort: string | null
  inputTokens: number
  outputTokens: number
  /** Characters of reasoning the model produced; they count as output tokens too. */
  reasoningChars: number
  /** Characters of visible text. */
  contentChars: number
  tools: Array<{ name: string; argChars: number }>
}

export function traceStep(step: StepTrace): void {
  const file = process.env.HIVE_STEP_LOG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...step }) + "\n")
  } catch { /* a diagnostic must never break a call */ }
}
