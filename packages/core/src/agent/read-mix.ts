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
export const INDEX_READ_TOOLS: ReadonlySet<string> = new Set(["search_knowledge", "get_project_context", "outline", "find_symbol", "dependents", "tests_for"])

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

/** Disk reads a reader may make before being pointed back to the index. */
export const DISK_READ_NUDGE_AFTER = 6
const READERS = new Set(["scout", "planner"])
const diskReads = new Map<string, number>()
const MAX_TRACKED_READERS = 500

/**
 * A line to append to the result of a disk read when a reader (scout, planner) has made several in one run.
 * Soft: it never blocks, it says what the index can do instead. Repeats every few reads, not on each one.
 */
export function diskReadNudge(runId: string, agentType: string | undefined, toolName: string): string | undefined {
  if (!agentType || !READERS.has(agentType) || classifyRead(toolName) !== "disk") return undefined
  if (diskReads.size >= MAX_TRACKED_READERS && !diskReads.has(runId)) diskReads.delete(diskReads.keys().next().value as string)
  const count = (diskReads.get(runId) ?? 0) + 1
  diskReads.set(runId, count)
  if (count < DISK_READ_NUDGE_AFTER || (count - DISK_READ_NUDGE_AFTER) % 4 !== 0) return undefined
  return `\n\n[Llevas ${count} lecturas de disco en esta tarea. El índice responde sin leer archivos: outline(path) lista lo que declara un archivo con sus líneas, find_symbol(name) dice dónde se define algo, search_knowledge(type="code") devuelve fragmento y líneas. Lee el disco solo por rango (offset/limit) y para confirmar.]`
}
