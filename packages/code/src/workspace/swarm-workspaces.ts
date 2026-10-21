import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { filesInPatch, type SwarmIntegration, type SwarmWorkspaceRuntime } from "@johpaz/hivecode-core/agent/swarm-runtime"
import { WorkspaceManager, type WorkspaceAssignment } from "./manager"

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x"
}

/**
 * Private copies of the task worktree for parallel instances of a worker (`builder#2`…).
 *
 * Each copy is a git worktree of the *task worktree*, seeded with everything the task has produced so
 * far (committed or not), so an instance starts from the shared state. When it finishes its diff is
 * applied back to the task worktree and the copy is removed; the next delegation (or a revision) gets
 * a new copy of the then-current state. Merges are serialised: two instances finishing together must
 * not apply patches to the same tree at once.
 */
export function createSwarmWorkspaceRuntime(
  manager: WorkspaceManager,
  onProblem: (message: string) => void = () => {},
  rootDir = join(tmpdir(), "hivecode-worktrees"),
): SwarmWorkspaceRuntime {
  const live = new Map<string, WorkspaceAssignment & { group: string }>()
  let mergeChain: Promise<unknown> = Promise.resolve()
  const keyOf = (taskId: string, instanceId: string) => `${taskId}\0${instanceId}`

  const drop = async (key: string) => {
    const assignment = live.get(key)
    if (!assignment) return
    live.delete(key)
    await manager.cleanup(assignment).catch(() => {})
  }

  return {
    async prepare({ taskId, instanceId, baseWorkspace }) {
      const key = keyOf(taskId, instanceId)
      await drop(key) // a revision starts again from the current shared state
      const name = `swarm-${slug(taskId)}-${slug(instanceId)}`
      const base = manager.createAssignment({ taskId: name, projectPath: baseWorkspace, mutating: true })
      const assignment = {
        ...base,
        // `hivecode/task-*` is reserved for task worktrees (`/task cleanup` lists those).
        branchName: `hivecode/${name}`,
        worktreePath: join(rootDir, name),
        group: taskId,
      }
      if (existsSync(assignment.worktreePath)) await manager.cleanup(assignment).catch(() => {})
      await manager.prepare(assignment)
      live.set(key, assignment)
      return assignment.worktreePath
    },

    integrate({ taskId, instanceId }) {
      const run = async (): Promise<SwarmIntegration> => {
        const key = keyOf(taskId, instanceId)
        const assignment = live.get(key)
        if (!assignment) return { status: "noop", files: [] }
        const result = await manager.integrate(assignment)
        const files = filesInPatch(result.diff ?? "")
        if (result.status === "integrated" || result.status === "noop") {
          await drop(key)
        } else {
          // Kept on disk for inspection; the revision's prepare() replaces it.
          onProblem(`⚠ ${instanceId}: no pude fusionar su trabajo (${result.status})${files.length ? ` en ${files.slice(0, 5).join(", ")}` : ""}. ${String(result.error ?? "").split("\n")[0].slice(0, 160)}`)
        }
        return { status: result.status, files, error: result.error }
      }
      const next = mergeChain.then(run, run)
      mergeChain = next.catch(() => {})
      return next
    },

    async cleanup(taskId) {
      for (const [key, assignment] of [...live]) if (!taskId || assignment.group === taskId) await drop(key)
    },
  }
}
