/**
 * Who delegated what to whom.
 *
 * Every tool call is already persisted in `toolRuns` with its arguments, and each run knows its
 * agent, so delegations are on record. What was missing was a way to read them: when a worker did
 * something odd, the question is "what was it told, by whom, and how did it end". This answers it
 * without a new write path.
 */
import { col } from "../storage/hive"
import type { AgentRunDoc, ToolRunDoc } from "../storage/collections"

const DELEGATION_TOOLS = new Set(["task_delegate", "task_revise", "spawn_agent"])
const TASK_CHARS = 160

export interface DelegationEntry {
  at: number
  tool: string
  /** The agent that delegated. */
  from: string
  /** Who received it: the worker, or the temporary agent's purpose. */
  to: string
  specialty?: string
  task: string
  acceptanceCount: number
  status: ToolRunDoc["status"]
  durationMs: number | null
  error: string | null
  /** The outer task this belongs to. */
  taskId: string
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json)
    return value && typeof value === "object" ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function clip(text: unknown): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > TASK_CHARS ? `${flat.slice(0, TASK_CHARS - 1)}…` : flat
}

/** Newest first. `taskId` keeps only delegations whose outer task id contains that text. */
export async function listDelegations(opts: { limit?: number; taskId?: string } = {}): Promise<DelegationEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200)
  const runs = (await (await col<ToolRunDoc>("toolRuns")).scan())
    .map(entry => entry.doc)
    .filter(run => DELEGATION_TOOLS.has(run.tool_name))
    .filter(run => !opts.taskId || run.task_id.includes(opts.taskId))
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, limit)
  if (runs.length === 0) return []

  const agentRuns = col<AgentRunDoc>("agentRuns")
  const agentOf = new Map<string, string>()
  for (const run of runs) {
    if (agentOf.has(run.run_id)) continue
    agentOf.set(run.run_id, (await (await agentRuns).get(run.run_id))?.doc.agent_id ?? "?")
  }

  return runs.map((run): DelegationEntry => {
    const args = parseArgs(run.args_json)
    const spawned = run.tool_name === "spawn_agent"
    return {
      at: run.started_at,
      tool: run.tool_name,
      from: agentOf.get(run.run_id) ?? "?",
      to: spawned ? "(subagente)" : String(args.worker_id ?? args.ref ?? args.task_id ?? "?"),
      // Models write "builder/integration"; the worker is already shown, so keep the last part.
      specialty: typeof args.specialty === "string" ? args.specialty.split(/[/:]/).pop() || undefined : undefined,
      task: clip(args.task_description ?? args.purpose ?? args.feedback ?? ""),
      acceptanceCount: Array.isArray(args.acceptance) ? args.acceptance.length : 0,
      status: run.status,
      durationMs: run.duration_ms,
      error: run.error,
      taskId: run.task_id,
    }
  })
}

/** One block of text per delegation, for `/task delegations`. */
export function formatDelegations(entries: DelegationEntry[]): string {
  if (entries.length === 0) return "  No hay delegaciones registradas."
  return entries.map(entry => {
    const when = new Date(entry.at * (entry.at < 1e12 ? 1000 : 1)).toLocaleTimeString("es-ES", { hour12: false })
    const head = `  ${when}  ${entry.from} → ${entry.to}${entry.specialty ? `/${entry.specialty}` : ""}  [${entry.tool}]`
    const tail = [
      entry.status,
      entry.durationMs != null ? `${(entry.durationMs / 1000).toFixed(1)}s` : null,
      entry.acceptanceCount ? `${entry.acceptanceCount} criterio${entry.acceptanceCount > 1 ? "s" : ""}` : null,
    ].filter(Boolean).join(" · ")
    return [head, `    ${entry.task || "(sin descripción)"}`, `    ${tail}${entry.error ? ` · error: ${clip(entry.error)}` : ""}`].join("\n")
  }).join("\n\n")
}
