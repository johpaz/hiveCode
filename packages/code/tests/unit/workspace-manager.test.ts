import { describe, expect, test } from "bun:test"
import { WorkspaceManager } from "../../src/workspace/manager"

describe("WorkspaceManager", () => {
  test("read-only tasks use the base workspace", () => {
    const manager = new WorkspaceManager({ rootDir: "/tmp/hive-worktrees" })
    const assignment = manager.createAssignment({
      taskId: "Task 123",
      projectPath: "/repo",
      mutating: false,
    })

    expect(assignment.isolated).toBe(false)
    expect(assignment.worktreePath).toBe("/repo")
    expect(assignment.workspaceId).toBe("base:task-123")
  })

  test("mutating tasks get deterministic worktree assignment", () => {
    const manager = new WorkspaceManager({ rootDir: "/tmp/hive-worktrees" })
    const assignment = manager.createAssignment({
      taskId: "Task 123",
      projectPath: "/repo",
      mutating: true,
    })

    expect(assignment.isolated).toBe(true)
    expect(assignment.branchName).toBe("hivecode/task-task-123")
    expect(assignment.baselineRef).toBe("refs/hivecode/baselines/task-123")
    expect(assignment.worktreePath).toBe("/tmp/hive-worktrees/task-123")
  })

  test("prepare and cleanup call git worktree commands through injected runner", async () => {
    const calls: Array<{ cmd: string[]; cwd: string }> = []
    const manager = new WorkspaceManager({
      rootDir: "/tmp/hive-worktrees",
      runCommand: async (cmd, cwd) => {
        calls.push({ cmd, cwd })
        if (cmd.includes("write-tree")) return { ok: true, stdout: "tree-sha\n" }
        if (cmd.includes("rev-parse")) return { ok: true, stdout: "head-sha\n" }
        if (cmd.includes("commit-tree")) return { ok: true, stdout: "baseline-sha\n" }
        return { ok: true }
      },
    })
    const assignment = manager.createAssignment({ taskId: "task-1", projectPath: "/repo", mutating: true })

    await manager.prepare(assignment, "main")
    await manager.cleanup(assignment)

    expect(calls[0]).toEqual({
      cwd: "/repo",
      cmd: ["git", "worktree", "add", "-B", "hivecode/task-task-1", "/tmp/hive-worktrees/task-1", "main"],
    })
    expect(calls.some(({ cmd, cwd }) =>
      cwd === "/tmp/hive-worktrees/task-1" &&
      cmd[0] === "git" &&
      cmd.includes("commit-tree")
    )).toBe(true)
    expect(calls.some(({ cmd, cwd }) =>
      cwd === "/tmp/hive-worktrees/task-1" &&
      cmd[0] === "git" &&
      cmd[1] === "reset" &&
      cmd[2] === "--hard" &&
      cmd[3] === "baseline-sha"
    )).toBe(true)
    expect(calls.some(({ cmd, cwd }) =>
      cwd === "/repo" &&
      cmd.join(" ") === "git worktree remove --force /tmp/hive-worktrees/task-1"
    )).toBe(true)
    expect(calls.some(({ cmd, cwd }) =>
      cwd === "/repo" &&
      cmd.join(" ") === "git update-ref -d refs/hivecode/baselines/task-1"
    )).toBe(true)
    expect(calls.some(({ cmd, cwd }) =>
      cwd === "/repo" &&
      cmd.join(" ") === "git branch -D hivecode/task-task-1"
    )).toBe(true)
  })

  test("diff includes untracked files before producing a binary patch", async () => {
    const calls: Array<{ cmd: string[]; cwd: string }> = []
    const manager = new WorkspaceManager({
      rootDir: "/tmp/hive-worktrees",
      runCommand: async (cmd, cwd) => {
        calls.push({ cmd, cwd })
        if (cmd[1] === "ls-files") return { ok: true, stdout: "src/new.ts\0" }
        if (cmd[1] === "diff") return { ok: true, stdout: "diff --git a/src/new.ts b/src/new.ts\n" }
        return { ok: true }
      },
    })
    const assignment = manager.createAssignment({ taskId: "task-1", projectPath: "/repo", mutating: true })

    const diff = await manager.diff(assignment)

    expect(diff).toContain("diff --git")
    expect(calls[0].cmd).toEqual(["git", "ls-files", "--others", "--exclude-standard", "-z"])
    expect(calls[1].cmd).toEqual(["git", "add", "-N", "--", "src/new.ts"])
    expect(calls[2].cmd).toEqual(["git", "diff", "--binary", "refs/hivecode/baselines/task-1", "--"])
  })

  test("integrate applies a generated patch to the base workspace", async () => {
    const calls: Array<{ cmd: string[]; cwd: string }> = []
    const manager = new WorkspaceManager({
      rootDir: "/tmp/hive-worktrees",
      runCommand: async (cmd, cwd) => {
        calls.push({ cmd, cwd })
        if (cmd[1] === "ls-files") return { ok: true, stdout: "" }
        if (cmd[1] === "diff") return { ok: true, stdout: "diff --git a/a.txt b/a.txt\n" }
        return { ok: true }
      },
    })
    const assignment = manager.createAssignment({ taskId: "task-1", projectPath: "/repo", mutating: true })

    const result = await manager.integrate(assignment)

    expect(result.status).toBe("integrated")
    expect(calls.some(({ cmd, cwd }) =>
      cwd === "/repo" &&
      cmd[0] === "git" &&
      cmd[1] === "apply" &&
      cmd[2] === "--3way"
    )).toBe(true)
  })

  test("integrate reports conflicts without cleaning the worktree", async () => {
    const manager = new WorkspaceManager({
      rootDir: "/tmp/hive-worktrees",
      runCommand: async (cmd) => {
        if (cmd[1] === "ls-files") return { ok: true, stdout: "" }
        if (cmd[1] === "diff") return { ok: true, stdout: "diff --git a/a.txt b/a.txt\n" }
        if (cmd[1] === "apply") return { ok: false, stderr: "patch does not apply" }
        return { ok: true }
      },
    })
    const assignment = manager.createAssignment({ taskId: "task-1", projectPath: "/repo", mutating: true })

    const result = await manager.integrate(assignment)

    expect(result.status).toBe("conflict")
    expect(result.error).toContain("patch does not apply")
  })
})
