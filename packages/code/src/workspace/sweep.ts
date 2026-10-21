import type { TaskWorktree, WorkspaceManager } from "./manager"

export interface SweepResult {
  removed: TaskWorktree[]
  /** Work that was never integrated: only `force` deletes it. */
  kept: TaskWorktree[]
  inUse: TaskWorktree[]
  errors: Array<{ worktree: TaskWorktree; error: string }>
}

/**
 * Removes the worktrees a finished task left behind (`hivecode/task-*`, and the private copies of parallel
 * workers, `hivecode/swarm-*`). One implementation for `/task cleanup` and for the sweep at startup.
 *
 * A worktree is never removed while its task is still going, and never when it holds work that was not
 * integrated (unless `force`): that work exists nowhere else.
 */
export async function sweepTaskWorktrees(input: {
  manager: WorkspaceManager
  projectPath: string
  /** Slugs (as in the branch name) of the tasks that are still going. */
  inUseSlugs: Set<string>
  force?: boolean
}): Promise<SweepResult> {
  const { manager, projectPath, inUseSlugs, force = false } = input
  const result: SweepResult = { removed: [], kept: [], inUse: [], errors: [] }
  for (const worktree of await manager.listTaskWorktrees(projectPath, { includeSwarm: true })) {
    const live = [...inUseSlugs].some(slug => worktree.taskSlug === slug || worktree.branch.startsWith(`hivecode/swarm-${slug}-`))
    if (live) {
      result.inUse.push(worktree)
      continue
    }
    if (worktree.hasChanges && !force) { result.kept.push(worktree); continue }
    try {
      const assignment = manager.createAssignment({ taskId: worktree.taskSlug, projectPath, mutating: true })
      await manager.cleanup({ ...assignment, worktreePath: worktree.path, branchName: worktree.branch })
      result.removed.push(worktree)
    } catch (error) {
      result.errors.push({ worktree, error: (error as Error).message })
    }
  }
  return result
}
