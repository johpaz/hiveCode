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
    expect(assignment.worktreePath).toBe("/tmp/hive-worktrees/task-123")
  })

  test("prepare and cleanup call git worktree commands through injected runner", async () => {
    const calls: Array<{ cmd: string[]; cwd: string }> = []
    const manager = new WorkspaceManager({
      rootDir: "/tmp/hive-worktrees",
      runCommand: async (cmd, cwd) => {
        calls.push({ cmd, cwd })
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
    expect(calls[1]).toEqual({
      cwd: "/repo",
      cmd: ["git", "worktree", "remove", "--force", "/tmp/hive-worktrees/task-1"],
    })
  })
})
