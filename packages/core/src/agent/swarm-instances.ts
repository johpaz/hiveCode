/**
 * Parallel instances of one worker profile: `builder`, `builder#2`, `builder#3`.
 *
 * An instance is a clone of the base profile (tools, skills, prompt, model) with its own id, so it
 * gets its own thread (and `task_revise` resumes it with its context) and its own workspace.
 */
import { col } from "../storage/hive"
import type { AgentDoc } from "../storage/collections"

/** Instances of one profile that may run at once, the base one included. */
export const MAX_INSTANCES = 3

/** `builder#2` → `{ base: "builder", n: 2 }`; a plain id is instance 1. */
export function parseInstanceId(id: string): { base: string; n: number } {
  const match = /^(.+)#(\d+)$/.exec(id)
  return match ? { base: match[1], n: Number(match[2]) } : { base: id, n: 1 }
}

export function instanceId(base: string, n: number): string {
  return n <= 1 ? base : `${base}#${n}`
}

/**
 * The agent doc of an instance, cloned from its base profile on first use. Returns null when the base
 * profile does not exist or the instance number is out of range.
 */
export async function ensureInstance(id: string): Promise<AgentDoc | null> {
  const { base, n } = parseInstanceId(id)
  const agents = await col<AgentDoc>("agents")
  const existing = await agents.get(id)
  if (existing) return existing.doc
  if (n < 2 || n > MAX_INSTANCES) return null
  const baseDoc = (await agents.get(base))?.doc
  if (!baseDoc || baseDoc.role !== "worker") return null
  const clone: AgentDoc = {
    ...baseDoc,
    id,
    name: `${baseDoc.name} ${n}`,
    ephemeral: true,
    // Its own workspace is assigned per delegation; the base profile's is not shared.
    workspace: null,
    updated_at: Math.floor(Date.now() / 1000),
  }
  await agents.put(id, clone, { expectedVersion: 0 }).catch(() => {})
  return (await agents.get(id))?.doc ?? clone
}

const WRITING_TOOLS = ["fs_write", "fs_edit", "fs_delete", "shell_executor", "run_script", "git_commit", "git_rollback"]

/**
 * Whether a profile can change the workspace. A reader (scout, planner) shares the task workspace safely,
 * so its duplicates need no private worktree. A profile with no tool list is assumed to write.
 */
export function canWriteWorkspace(doc: Pick<AgentDoc, "tools_json">): boolean {
  if (!doc.tools_json) return true
  try {
    const tools = JSON.parse(doc.tools_json)
    return !Array.isArray(tools) || tools.some((t: unknown) => typeof t === "string" && WRITING_TOOLS.includes(t))
  } catch {
    return true
  }
}

/** Removes the instance docs a task created; the base profile is never touched. */
export async function removeInstances(ids: Iterable<string>): Promise<void> {
  const agents = await col<AgentDoc>("agents")
  for (const id of ids) {
    if (parseInstanceId(id).n < 2) continue
    const row = await agents.get(id)
    if (row?.doc.ephemeral) await agents.delete(id).catch(() => {})
  }
}

/** Drops every instance doc left by earlier tasks (they are rebuilt from the base profile on demand). */
export async function purgeInstances(): Promise<void> {
  const agents = await col<AgentDoc>("agents")
  const ids = (await agents.scan({})).map(e => e.doc.id).filter(id => parseInstanceId(id).n >= 2)
  await removeInstances(ids)
}
