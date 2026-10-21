/**
 * What each role actually used of the tools it started with, from the runs the database already holds.
 *
 * A loadout is a guess until it is compared with use: a tool that starts in every scout and is never
 * called costs its description in every turn; one that is searched for in most runs belongs in the
 * starting set. This only reports. Changing a loadout stays a decision (see `agent/loadout.ts`).
 */
import { classifyRead } from "../agent/read-mix"

interface RunRow { id: string; agent_id: string; context_metrics_json?: string }
interface ToolRow { run_id?: string; tool_name: string }

export interface RoleLoadoutReport {
  role: string
  runs: number
  /** Tools the role started with in at least one run. */
  loaded: string[]
  /** Loaded and never called across `runs`. */
  unused: string[]
  /** Called, with how many runs called each (descending). */
  used: Array<{ tool: string; runs: number }>
  /** Runs that searched for capabilities (not code): each cost a turn. */
  discoveryRuns: number
  /** Share of the role's reads that went to disk rather than the index, 0..1 (null when it read nothing). */
  diskShare: number | null
  /** Average prompt tokens of tools / skills at the start of a run, when the run recorded them. */
  startTokens: { tools: number; skills: number } | null
}

/** `scout#2` is a duplicate of `scout`: the role is the base profile. */
const roleOf = (agentId: string) => agentId.replace(/#\d+$/, "")

function loadoutOf(run: RunRow): { tools: string[]; tokens?: { tools: number; skills: number } } | null {
  try {
    const metrics = JSON.parse(run.context_metrics_json || "{}")
    if (!Array.isArray(metrics.loadout?.tools)) return null
    return { tools: metrics.loadout.tools, tokens: typeof metrics.tools === "number" ? { tools: metrics.tools, skills: metrics.skills ?? 0 } : undefined }
  } catch { return null }
}

export function reportLoadouts(runs: RunRow[], tools: ToolRow[]): RoleLoadoutReport[] {
  const byRun = new Map<string, Set<string>>()
  for (const call of tools) {
    if (!call.run_id) continue
    if (!byRun.has(call.run_id)) byRun.set(call.run_id, new Set())
    byRun.get(call.run_id)!.add(call.tool_name)
  }
  const roles = [...new Set(runs.map(run => roleOf(run.agent_id)))].sort()
  return roles.map(role => {
    const mine = runs.filter(run => roleOf(run.agent_id) === role)
    const loaded = new Set<string>()
    const usedBy = new Map<string, number>()
    let discoveryRuns = 0, disk = 0, index = 0
    const tokens: Array<{ tools: number; skills: number }> = []
    for (const run of mine) {
      const loadout = loadoutOf(run)
      for (const name of loadout?.tools ?? []) loaded.add(name)
      if (loadout?.tokens) tokens.push(loadout.tokens)
      const called = byRun.get(run.id) ?? new Set<string>()
      for (const name of called) usedBy.set(name, (usedBy.get(name) ?? 0) + 1)
      if (called.has("search_knowledge")) discoveryRuns++
    }
    for (const call of tools) {
      if (!mine.some(run => run.id === call.run_id)) continue
      const kind = classifyRead(call.tool_name)
      if (kind === "disk") disk++
      else if (kind === "index") index++
    }
    const avg = (pick: (t: { tools: number; skills: number }) => number) => Math.round(tokens.reduce((sum, t) => sum + pick(t), 0) / tokens.length)
    return {
      role, runs: mine.length,
      loaded: [...loaded].sort(),
      unused: [...loaded].filter(name => !usedBy.has(name)).sort(),
      used: [...usedBy].map(([tool, count]) => ({ tool, runs: count })).sort((a, b) => b.runs - a.runs || a.tool.localeCompare(b.tool)),
      discoveryRuns,
      diskShare: disk + index ? disk / (disk + index) : null,
      startTokens: tokens.length ? { tools: avg(t => t.tools), skills: avg(t => t.skills) } : null,
    }
  })
}
