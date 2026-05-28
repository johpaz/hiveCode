import { join } from "node:path"
import { tmpdir } from "node:os"

export interface WorkspaceAssignment {
  workspaceId: string
  taskId: string
  projectPath: string
  worktreePath: string
  branchName: string
  isolated: boolean
  mutating: boolean
}

export interface WorkspaceManagerOptions {
  rootDir?: string
  runCommand?: (cmd: string[], cwd: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string }>
}

export interface CreateWorkspaceInput {
  taskId: string
  projectPath: string
  mutating: boolean
  baseRef?: string
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "task"
}

async function defaultRunCommand(cmd: string[], cwd: string): Promise<{ ok: boolean; stdout?: string; stderr?: string }> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: exitCode === 0, stdout, stderr }
}

export class WorkspaceManager {
  private rootDir: string
  private runCommand: NonNullable<WorkspaceManagerOptions["runCommand"]>

  constructor(options: WorkspaceManagerOptions = {}) {
    this.rootDir = options.rootDir ?? join(tmpdir(), "hivecode-worktrees")
    this.runCommand = options.runCommand ?? defaultRunCommand
  }

  createAssignment(input: CreateWorkspaceInput): WorkspaceAssignment {
    const taskSlug = slug(input.taskId)
    if (!input.mutating) {
      return {
        workspaceId: `base:${taskSlug}`,
        taskId: input.taskId,
        projectPath: input.projectPath,
        worktreePath: input.projectPath,
        branchName: input.baseRef ?? "HEAD",
        isolated: false,
        mutating: false,
      }
    }

    const branchName = `hivecode/task-${taskSlug}`
    return {
      workspaceId: `worktree:${taskSlug}`,
      taskId: input.taskId,
      projectPath: input.projectPath,
      worktreePath: join(this.rootDir, taskSlug),
      branchName,
      isolated: true,
      mutating: true,
    }
  }

  async prepare(assignment: WorkspaceAssignment, baseRef = "HEAD"): Promise<void> {
    if (!assignment.isolated) return
    const result = await this.runCommand(
      ["git", "worktree", "add", "-B", assignment.branchName, assignment.worktreePath, baseRef],
      assignment.projectPath,
    )
    if (!result.ok) {
      throw new Error(`Failed to create worktree: ${result.stderr || result.stdout || "unknown error"}`)
    }
  }

  async cleanup(assignment: WorkspaceAssignment): Promise<void> {
    if (!assignment.isolated) return
    const result = await this.runCommand(
      ["git", "worktree", "remove", "--force", assignment.worktreePath],
      assignment.projectPath,
    )
    if (!result.ok) {
      throw new Error(`Failed to remove worktree: ${result.stderr || result.stdout || "unknown error"}`)
    }
  }
}
