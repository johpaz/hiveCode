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
  /** What the harness estimated for this request (messages + tools). Real / estimated is the estimator's error. */
  estimatedInputTokens: number
  outputTokens: number
  /** Characters of reasoning the model produced; they count as output tokens too. */
  reasoningChars: number
  /** Characters of visible text. */
  contentChars: number
  /** For a shell command, its text (clipped): the one thing worth reading when a run goes wrong. */
  tools: Array<{ name: string; argChars: number; preview?: string }>
}

/** The command of a `shell_executor` call, clipped, for the trace. */
export function commandPreview(args: unknown, max = 400): string {
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args
    const cmd = (parsed as { cmd?: unknown; command?: unknown })?.cmd ?? (parsed as { command?: unknown })?.command
    return typeof cmd === "string" ? cmd.slice(0, max) : ""
  } catch { return "" }
}

/** One tool answer as the model received it: how big it was, so a run's context can be read back by tool. */
export interface ResultTrace {
  agent: string
  turn: number
  tool: string
  chars: number
}

export function traceResult(result: ResultTrace): void {
  const file = process.env.HIVE_STEP_LOG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind: "result", ...result }) + "\n")
  } catch { /* a diagnostic must never break a call */ }
}

export function traceStep(step: StepTrace): void {
  const file = process.env.HIVE_STEP_LOG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...step }) + "\n")
  } catch { /* a diagnostic must never break a call */ }
}
