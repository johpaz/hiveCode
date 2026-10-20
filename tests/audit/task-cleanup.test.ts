import { afterEach, beforeEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { WorkspaceManager } from "../../packages/code/src/workspace/manager"
import { parseInternalCommand } from "../../packages/code/src/coordinator/command-parser"

// `/halt` deja el worktree de una tarea cancelada a propósito, y con el tiempo se acumulan.
// `/task cleanup` los borra sin perder trabajo: los que tienen cambios sin integrar se conservan.
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString()

const previousDb = process.env.HIVE_DB_PATH
const previousCwd = process.cwd()
let repo = ""

beforeEach(() => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-cleanup-"))
  repo = mkdtempSync(join(tmpdir(), "hive-cleanup-repo-"))
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "init")
  process.chdir(repo)
})

afterEach(() => {
  process.chdir(previousCwd)
  closeHiveDb()
  if (previousDb === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousDb
})

async function leftover(id: string, withWork: boolean) {
  const manager = new WorkspaceManager({ rootDir: mkdtempSync(join(tmpdir(), "hive-cleanup-root-")) })
  const assignment = manager.createAssignment({ taskId: id, projectPath: repo, mutating: true })
  await manager.prepare(assignment)
  if (withWork) writeFileSync(join(assignment.worktreePath, "work.ts"), "export const w = 1\n")
  return assignment
}

const branches = () => git(repo, "branch", "--list", "hivecode/*").trim()

test("/task cleanup removes empty leftover worktrees and keeps the ones with unintegrated work", async () => {
  const empty = await leftover("old-empty", false)
  const dirty = await leftover("old-dirty", true)

  const result = await parseInternalCommand("/task cleanup")

  expect(result.output ?? "").toContain("1 de 2 worktrees borrados")
  expect(existsSync(empty.worktreePath)).toBe(false)
  expect(existsSync(dirty.worktreePath)).toBe(true)
  expect(branches()).toContain("old-dirty")
  expect(branches()).not.toContain("old-empty")
})

test("/task cleanup --force also removes the ones with work", async () => {
  const dirty = await leftover("old-dirty", true)

  const result = await parseInternalCommand("/task cleanup --force")

  expect(result.output ?? "").toContain("1 de 1 worktrees borrados")
  expect(existsSync(dirty.worktreePath)).toBe(false)
  expect(branches()).toBe("")
})

test("/task cleanup says so when there is nothing to clean", async () => {
  const result = await parseInternalCommand("/task cleanup")
  expect(result.output ?? "").toContain("No hay worktrees")
})
