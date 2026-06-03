import { existsSync, mkdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

export interface WorkspaceAssignment {
  workspaceId: string
  taskId: string
  projectPath: string
  worktreePath: string
  branchName: string
  baselineRef?: string
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

export interface WorkspaceIntegrationResult {
  status: "integrated" | "noop" | "conflict" | "failed"
  diff?: string
  error?: string
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
      baselineRef: `refs/hivecode/baselines/${taskSlug}`,
      isolated: true,
      mutating: true,
    }
  }

  async prepare(assignment: WorkspaceAssignment, baseRef = "HEAD"): Promise<void> {
    if (!assignment.isolated) return
    if (!existsSync(this.rootDir)) mkdirSync(this.rootDir, { recursive: true })
    const result = await this.runCommand(
      ["git", "worktree", "add", "-B", assignment.branchName, assignment.worktreePath, baseRef],
      assignment.projectPath,
    )
    if (!result.ok) {
      throw new Error(`Failed to create worktree: ${result.stderr || result.stdout || "unknown error"}`)
    }
    await this.seedBaseline(assignment, baseRef)
  }

  async diff(assignment: WorkspaceAssignment): Promise<string> {
    if (!assignment.isolated) return ""

    const untracked = await this.runCommand(
      ["git", "ls-files", "--others", "--exclude-standard", "-z"],
      assignment.worktreePath,
    )
    if (untracked.ok && untracked.stdout) {
      const files = untracked.stdout.split("\0").filter(Boolean)
      if (files.length > 0) {
        await this.runCommand(["git", "add", "-N", "--", ...files], assignment.worktreePath)
      }
    }

    const baseRef = assignment.baselineRef ?? "HEAD"
    const diff = await this.runCommand(["git", "diff", "--binary", baseRef, "--"], assignment.worktreePath)
    if (!diff.ok) {
      throw new Error(`Failed to diff worktree: ${diff.stderr || diff.stdout || "unknown error"}`)
    }
    return diff.stdout ?? ""
  }

  async integrate(assignment: WorkspaceAssignment): Promise<WorkspaceIntegrationResult> {
    if (!assignment.isolated) return { status: "noop" }

    let diff = ""
    try {
      diff = await this.diff(assignment)
    } catch (err) {
      return { status: "failed", error: (err as Error).message }
    }

    if (!diff.trim()) return { status: "noop", diff }

    const patchPath = join(tmpdir(), `hivecode-${assignment.taskId}-${Date.now()}.patch`)
    try {
      await Bun.write(patchPath, diff)
      const applied = await this.runCommand(
        ["git", "apply", "--3way", "--whitespace=nowarn", patchPath],
        assignment.projectPath,
      )
      if (applied.ok) return { status: "integrated", diff }
      const error = applied.stderr || applied.stdout || "unknown integration failure"
      return /conflict|patch does not apply|failed/i.test(error)
        ? { status: "conflict", diff, error }
        : { status: "failed", diff, error }
    } finally {
      try {
        await Bun.file(patchPath).delete()
      } catch {
        // best effort
      }
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
    if (assignment.baselineRef) {
      await this.runCommand(["git", "update-ref", "-d", assignment.baselineRef], assignment.projectPath)
    }
    await this.runCommand(["git", "branch", "-D", assignment.branchName], assignment.projectPath)
  }

  private async seedBaseline(assignment: WorkspaceAssignment, baseRef: string): Promise<void> {
    const baseDiff = await this.runCommand(["git", "diff", "--binary", baseRef, "--"], assignment.projectPath)
    if (!baseDiff.ok) {
      throw new Error(`Failed to inspect base workspace: ${baseDiff.stderr || baseDiff.stdout || "unknown error"}`)
    }

    if (baseDiff.stdout?.trim()) {
      const patchPath = join(tmpdir(), `hivecode-base-${assignment.taskId}-${Date.now()}.patch`)
      try {
        await Bun.write(patchPath, baseDiff.stdout)
        const applied = await this.runCommand(
          ["git", "apply", "--whitespace=nowarn", patchPath],
          assignment.worktreePath,
        )
        if (!applied.ok) {
          throw new Error(`Failed to seed base changes: ${applied.stderr || applied.stdout || "unknown error"}`)
        }
      } finally {
        try {
          await Bun.file(patchPath).delete()
        } catch {
          // best effort
        }
      }
    }

    const untracked = await this.runCommand(
      ["git", "ls-files", "--others", "--exclude-standard", "-z"],
      assignment.projectPath,
    )
    if (!untracked.ok) {
      throw new Error(`Failed to inspect untracked files: ${untracked.stderr || untracked.stdout || "unknown error"}`)
    }
    for (const file of (untracked.stdout ?? "").split("\0").filter(Boolean)) {
      const source = join(assignment.projectPath, file)
      const target = join(assignment.worktreePath, file)
      try {
        if (!await Bun.file(source).exists()) continue
        mkdirSync(dirname(target), { recursive: true })
        await Bun.write(target, Bun.file(source))
      } catch {
        // The file may have disappeared between ls-files and copy; ignore it.
      }
    }

    const add = await this.runCommand(["git", "add", "-A"], assignment.worktreePath)
    if (!add.ok) {
      throw new Error(`Failed to stage baseline: ${add.stderr || add.stdout || "unknown error"}`)
    }
    const tree = await this.runCommand(["git", "write-tree"], assignment.worktreePath)
    if (!tree.ok || !tree.stdout?.trim()) {
      throw new Error(`Failed to write baseline tree: ${tree.stderr || tree.stdout || "unknown error"}`)
    }
    const head = await this.runCommand(["git", "rev-parse", "HEAD"], assignment.worktreePath)
    if (!head.ok || !head.stdout?.trim()) {
      throw new Error(`Failed to resolve baseline parent: ${head.stderr || head.stdout || "unknown error"}`)
    }
    const commit = await this.runCommand(
      [
        "git",
        "-c", "user.name=HiveCode",
        "-c", "user.email=hivecode@local",
        "commit-tree", tree.stdout.trim(),
        "-p", head.stdout.trim(),
        "-m", `hivecode baseline for ${assignment.taskId}`,
      ],
      assignment.worktreePath,
    )
    if (!commit.ok || !commit.stdout?.trim()) {
      throw new Error(`Failed to create baseline commit: ${commit.stderr || commit.stdout || "unknown error"}`)
    }
    if (assignment.baselineRef) {
      const updateRef = await this.runCommand(
        ["git", "update-ref", assignment.baselineRef, commit.stdout.trim()],
        assignment.worktreePath,
      )
      if (!updateRef.ok) {
        throw new Error(`Failed to record baseline ref: ${updateRef.stderr || updateRef.stdout || "unknown error"}`)
      }
    }
    const reset = await this.runCommand(["git", "reset", "--hard", commit.stdout.trim()], assignment.worktreePath)
    if (!reset.ok) {
      throw new Error(`Failed to reset worktree to baseline: ${reset.stderr || reset.stdout || "unknown error"}`)
    }
  }
}
