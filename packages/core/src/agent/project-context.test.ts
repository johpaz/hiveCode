import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import { col } from "../storage/hive.ts"
import type { CodeGraphDoc, CodeSessionDoc } from "../storage/collections.ts"
import { buildContextPacket } from "./project-context.ts"
import { codeFileId } from "./source-index.ts"

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
    await graph.put(codeFileId(SESSION, file), {
      id: codeFileId(SESSION, file), session_id: SESSION, file_path: file,
      imports: "[]", exported_by: "[]", exports: "[]", functions: "[]", classes: "[]",
      complexity: 1, last_modified: null, indexed_at: new Date().toISOString(),
    }, { expectedVersion: 0 })

    const packet = await buildContextPacket(
      { sessionId: SESSION, workspace },
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

    expect((await resolveProjectScope({ sessionId: "wt-session", workspace: repo }))?.workspace).toBe(path.resolve(repo))
    expect((await resolveProjectScope({ sessionId: "wt-session", workspace: wt }))?.workspace).toBe(path.resolve(wt))
    await expect(resolveProjectScope({ sessionId: "wt-session", workspace: workspace })).rejects.toThrow("Session and workspace do not match")
  })
})
