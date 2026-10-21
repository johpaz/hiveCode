/**
 * How an exploration split between the project's index (HiveDB) and the disk.
 *
 * The index answers "where is it and what does it say" in one cheap call; the disk is for the
 * lines about to be edited. A scout that reads mostly from disk is paying for what the index
 * already holds, so the split is the number to watch when judging index-first exploration.
 */

/** Tools that walk the project on disk. */
export const DISK_READ_TOOLS: ReadonlySet<string> = new Set(["fs_read", "fs_list", "fs_glob", "search_in_files", "parse_ast"])

/** Tools that answer from the index. */
export const INDEX_READ_TOOLS: ReadonlySet<string> = new Set(["search_knowledge", "get_project_context", "outline", "find_symbol", "dependents"])

export type ReadKind = "disk" | "index" | "other"

export function classifyRead(toolName: string): ReadKind {
  if (DISK_READ_TOOLS.has(toolName)) return "disk"
  if (INDEX_READ_TOOLS.has(toolName)) return "index"
  return "other"
}

export interface ReadMix {
  disk: number
  index: number
  /** Characters the disk reads returned: the closest cheap proxy for the tokens they cost. */
  diskChars: number
}

interface ToolRow { run_id?: string; tool_name: string; result_json?: string | null }
interface RunRow { id: string; agent_id: string }

/** Disk vs index calls, in total and per agent (a run's agent comes from its `agentRuns` row). */
export function readMix(tools: ToolRow[], runs: RunRow[]): { total: ReadMix; byAgent: Record<string, ReadMix> } {
  const agentOf = new Map(runs.map(r => [r.id, r.agent_id]))
  const blank = (): ReadMix => ({ disk: 0, index: 0, diskChars: 0 })
  const total = blank()
  const byAgent: Record<string, ReadMix> = {}
  for (const tool of tools) {
    const kind = classifyRead(tool.tool_name)
    if (kind === "other") continue
    const agent = (tool.run_id && agentOf.get(tool.run_id)) || "unknown"
    const mine = (byAgent[agent] ??= blank())
    for (const mix of [total, mine]) {
      if (kind === "disk") { mix.disk++; mix.diskChars += tool.result_json?.length ?? 0 } else mix.index++
    }
  }
  return { total, byAgent }
}
