/**
 * Where the swarm gets a private workspace for each parallel instance of a worker.
 *
 * Core cannot import the `code` package (it owns git worktrees), so the code layer registers an
 * implementation here, the same way the TUI registers the tool-approval requester. Without one
 * (a plain CLI run, unit tests) instances share the parent's workspace and are not parallel writers.
 */
export interface SwarmIntegration {
  status: "integrated" | "noop" | "conflict" | "failed"
  /** Files the instance changed, as the patch names them. */
  files: string[]
  error?: string
}

export interface SwarmWorkspaceRuntime {
  /** A private workspace for `instanceId`, seeded from `baseWorkspace` (the task's worktree). */
  prepare(input: { taskId: string; instanceId: string; baseWorkspace: string }): Promise<string>
  /** Merge what the instance wrote back into `baseWorkspace`. */
  integrate(input: { taskId: string; instanceId: string }): Promise<SwarmIntegration>
  /** Drop every sub-workspace of a task (or of all tasks when omitted). */
  cleanup(taskId?: string): Promise<void>
}

let runtime: SwarmWorkspaceRuntime | null = null

export function registerSwarmRuntime(next: SwarmWorkspaceRuntime | null): void {
  runtime = next
}

export function getSwarmRuntime(): SwarmWorkspaceRuntime | null {
  return runtime
}

/** Files named by a unified diff (`diff --git a/x b/x`). */
export function filesInPatch(diff: string): string[] {
  const files = new Set<string>()
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) files.add(match[2])
  return [...files]
}
