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
  /** What the model said in this turn (clipped): the only place its reason for the calls that follow is written. */
  assistantText: string
  /** For each call, what it targets (a path, a pattern, a worker and its brief…) so a run can be read call by call. */
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

/** What a call is about, short: a path with its range, a search, a delegation's worker and the start of its brief. */
export function argsPreview(name: string, args: unknown, max = 160): string | undefined {
  let a: Record<string, unknown> = {}
  try { a = (typeof args === "string" ? JSON.parse(args) : args) as Record<string, unknown> ?? {} } catch { return undefined }
  const text = (v: unknown) => (typeof v === "string" ? v : "")
  switch (name) {
    case "shell_executor": return commandPreview(a, 400) || undefined
    case "fs_read": return `${text(a.path)}${a.offset !== undefined || a.limit !== undefined ? ` [${a.offset ?? 1}+${a.limit ?? "…"}]` : ""}`.slice(0, max)
    case "fs_list": case "fs_glob": case "outline": case "parse_ast": case "dependents": case "tests_for": case "fs_exists":
      return (text(a.path) || text(a.pattern)).slice(0, max) || undefined
    case "search_in_files": return `${text(a.pattern)} @ ${text(a.path)}`.slice(0, max)
    case "find_symbol": return text(a.name).slice(0, max) || undefined
    case "search_knowledge": return `${text(a.type) || "all"}: ${text(a.query)}`.slice(0, max)
    case "task_delegate": case "task_revise":
      return `${text(a.worker_id) || text(a.task_id)}${a.ref ? ` ${text(a.ref)}` : ""}${Array.isArray(a.after) && a.after.length ? ` after=${JSON.stringify(a.after)}` : ""}${a.context ? ` context=${text(a.context).length}c` : ""} | ${text(a.task_description || a.feedback).replace(/\s+/g, " ")}`.slice(0, max + 80)
    default: return undefined
  }
}

export function traceStep(step: StepTrace): void {
  const file = process.env.HIVE_STEP_LOG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...step }) + "\n")
  } catch { /* a diagnostic must never break a call */ }
}
