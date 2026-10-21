import { beforeEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceManager } from "../../packages/code/src/workspace/manager"
import { sweepTaskWorktrees } from "../../packages/code/src/workspace/sweep"
import { createSwarmWorkspaceRuntime } from "../../packages/code/src/workspace/swarm-workspaces"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString()

let repo = ""
let manager: WorkspaceManager
let root = ""

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "hive-sweep-repo-"))
  root = mkdtempSync(join(tmpdir(), "hive-sweep-root-"))
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init")
  manager = new WorkspaceManager({ rootDir: root })
})

async function leftover(id: string, withWork = false) {
  const assignment = manager.createAssignment({ taskId: id, projectPath: repo, mutating: true })
  await manager.prepare(assignment)
  if (withWork) writeFileSync(join(assignment.worktreePath, "work.ts"), "export const w = 1\n")
  return assignment
}

test("clean leftovers go, unintegrated work stays, a task still going is untouched", async () => {
  const clean = await leftover("done-clean")
  const dirty = await leftover("done-dirty", true)
  const live = await leftover("still-going")

  const result = await sweepTaskWorktrees({ manager, projectPath: repo, inUseSlugs: new Set(["still-going"]) })

  expect(result.removed.map(w => w.taskSlug)).toEqual(["done-clean"])
  expect(result.kept.map(w => w.taskSlug)).toEqual(["done-dirty"])
  expect(result.inUse.map(w => w.taskSlug)).toEqual(["still-going"])
  expect(existsSync(clean.worktreePath)).toBe(false)
  expect(existsSync(dirty.worktreePath)).toBe(true)
  expect(existsSync(live.worktreePath)).toBe(true)
  expect(git(repo, "branch", "--list", "hivecode/*")).not.toContain("done-clean")
})

test("force removes work that was never integrated", async () => {
  const dirty = await leftover("done-dirty", true)
  const result = await sweepTaskWorktrees({ manager, projectPath: repo, inUseSlugs: new Set(), force: true })
  expect(result.removed).toHaveLength(1)
  expect(existsSync(dirty.worktreePath)).toBe(false)
})

test("the private copies of parallel workers are swept too, and protected while their task is live", async () => {
  const task = await leftover("feat-1")
  const swarm = createSwarmWorkspaceRuntime(manager, () => {}, root)
  const copy = await swarm.prepare({ taskId: "feat-1", instanceId: "builder#2", baseWorkspace: task.worktreePath })
  // The copy hangs off the task worktree, but git lists every worktree of the repository from the main one.
  const live = await sweepTaskWorktrees({ manager, projectPath: repo, inUseSlugs: new Set(["feat-1"]) })
  expect(live.inUse.some(w => w.path === copy)).toBe(true)
  expect(existsSync(copy)).toBe(true)

  const swept = await sweepTaskWorktrees({ manager, projectPath: repo, inUseSlugs: new Set() })
  expect(swept.removed.some(w => w.path === copy)).toBe(true)
  expect(existsSync(copy)).toBe(false)
  expect(git(repo, "branch", "--list", "hivecode/swarm-*").trim()).toBe("")
})

test("cancelling a task removes its worktree when there is nothing to integrate, and keeps it when there is", async () => {
  const { CoordinatorManager } = await import("../../packages/code/src/workers/coordinator-manager")
  const { col } = await import("../../packages/core/src/storage/hive")
  const { closeHiveDb } = await import("../../packages/core/src/storage/hivedb")
  closeHiveDb(); process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-sweep-db-"))
  const tasks = await col<any>("codeTasks")
  for (const [id, withWork] of [["cancel-clean", false], ["cancel-dirty", true]] as const) {
    await tasks.put(id, { id, status: "running" })
    const assignment = await leftover(id, withWork)
    const runtime = new CoordinatorManager() as any
    runtime.activeTaskId = id
    runtime.workspaceManager = manager
    runtime.taskWorkspaces.set(id, assignment)
    runtime.taskSupervisor.createTask({ taskId: id, sessionId: "s", title: id, stage: "executing", executionPolicy: "auto" })
    await runtime.cancelTask(id)
    expect(existsSync(assignment.worktreePath)).toBe(withWork)
  }
})
