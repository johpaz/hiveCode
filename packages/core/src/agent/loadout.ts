/**
 * Which tools a worker starts with, beyond what its profile allows.
 *
 * A profile lists everything a role MAY use; what it starts with decides what it reaches for. A scout
 * handed `fs_list` and `fs_glob` walks the tree (measured: 11 directory walks beside 7 index calls in
 * one exploration) even when the project index answers the same question for a fraction of the
 * tokens. When the index is populated, the readers start without the two tree-walking tools:
 * `get_project_context`, `search_knowledge`, `outline`, `find_symbol` and `search_in_files` remain, and
 * a tool left out is still one `search_knowledge` away, so nothing becomes unreachable.
 *
 * `HIVECODE_READER_DISK_WALK=1` gives them back.
 */
import { col, ensureIndexes } from "../storage/hive"
import type { CodeGraphDoc } from "../storage/collections"

/** Profiles that explore and never edit. */
const READER_PROFILES = new Set(["scout", "planner"])
/** Tools that list the tree; the index (`get_project_context`, `outline`) answers the same. */
export const DISK_WALK_TOOLS: readonly string[] = ["fs_list", "fs_glob"]
/** Below this many indexed files the index is not worth trusting over a directory listing. */
const MIN_INDEXED_FILES = 3
const READY_CACHE_MS = 60_000

const readyCache = new Map<string, { ready: boolean; at: number }>()

/** Whether the project has an index worth exploring through. Cached briefly: a run asks once per context compile. */
export async function isProjectIndexed(projectId: string, now = Date.now()): Promise<boolean> {
  const cached = readyCache.get(projectId)
  if (cached && now - cached.at < READY_CACHE_MS) return cached.ready
  let ready = false
  try {
    await ensureIndexes([["codeGraph", "project_id"]])
    ready = (await (await col<CodeGraphDoc>("codeGraph")).findBy("project_id", projectId)).length >= MIN_INDEXED_FILES
  } catch { /* no index yet: keep the listing tools */ }
  readyCache.set(projectId, { ready, at: now })
  return ready
}

export function resetIndexedCache(): void { readyCache.clear() }

/** Tools to drop from a worker's starting loadout. */
export function omittedAtStart(agentType: string | undefined, indexed: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!agentType || !READER_PROFILES.has(agentType) || !indexed) return []
  if (env.HIVECODE_READER_DISK_WALK === "1") return []
  return [...DISK_WALK_TOOLS]
}
