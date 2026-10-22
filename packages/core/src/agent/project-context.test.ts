import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import { col } from "../storage/hive.ts"
import type { CodeGraphDoc, CodeSessionDoc } from "../storage/collections.ts"
import { buildContextPacket } from "./project-context.ts"
import { codeFileId } from "./source-index.ts"
import { projectIdentity } from "./project-identity.ts"

const previous = process.env.HIVE_DB_PATH
const SESSION = "session-packet"
let workspace = ""

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-packet-")), "hivedb")
  workspace = mkdtempSync(path.join(tmpdir(), "hivecode-packet-ws-"))
  mkdirSync(path.join(workspace, "packages", "core"), { recursive: true })
  writeFileSync(path.join(workspace, "AGENTS.md"), "Always write tests.\n")
  await ensureHiveDb()
})

afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

describe("buildContextPacket", () => {
  test("derives indexed areas from codeGraph alone", async () => {
    const file = path.join(workspace, "packages", "core", "a.ts")
    writeFileSync(file, "export const a = 1\n")
    const graph = await col<CodeGraphDoc>("codeGraph")
    const project = projectIdentity(workspace)
    const rel = path.relative(project.root, file)
    await graph.put(codeFileId(project.id, rel), {
      id: codeFileId(project.id, rel), project_id: project.id, file_path: rel,
      imports: "[]", exported_by: "[]", exports: "[]", functions: "[]", classes: "[]",
      complexity: 1, last_modified: null, indexed_at: new Date().toISOString(),
    }, { expectedVersion: 0 })

    const packet = await buildContextPacket(
      { projectId: project.id, sessionId: SESSION, workspace: project.root, root: project.root },
      { summaryOnly: true, tokenBudget: 2_000 },
    )

    expect(packet.context).toContain("Mandatory project instructions")
    expect(packet.context).toContain("Indexed areas: packages/core")
  })
})

describe("resolveProjectScope with an isolated worktree", () => {
  test("accepts the session's own git worktree and rejects a foreign directory", async () => {
    const { execFileSync } = await import("node:child_process")
    const { resolveProjectScope } = await import("./project-context")
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" })
    const repo = mkdtempSync(path.join(tmpdir(), "hivecode-wt-repo-"))
    git(repo, "init", "-q", "-b", "main")
    git(repo, "commit", "-q", "--allow-empty", "-m", "init")
    const wt = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-wt-")), "task")
    git(repo, "worktree", "add", "-q", "-B", "hivecode/task-x", wt)
    const sessions = await col<CodeSessionDoc>("codeSessions")
    await sessions.put("wt-session", { id: "wt-session", status: "active", project_path: repo } as CodeSessionDoc)

    const real = (p: string) => realpathSync(p)
    const atRepo = await resolveProjectScope({ sessionId: "wt-session", workspace: repo })
    const atWorktree = await resolveProjectScope({ sessionId: "wt-session", workspace: wt })
    expect(atRepo?.workspace).toBe(real(repo))
    expect(atWorktree?.workspace).toBe(real(wt))
    // The worktree reads its own files but is the same project, with the same root and index.
    expect(atWorktree?.projectId).toBe(atRepo?.projectId)
    expect(atWorktree?.root).toBe(real(repo))
    await expect(resolveProjectScope({ sessionId: "wt-session", workspace: workspace })).rejects.toThrow("Session and workspace do not match")
  })
})
