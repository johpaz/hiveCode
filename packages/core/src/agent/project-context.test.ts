import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import { col } from "../storage/hive.ts"
import type { CodeGraphDoc } from "../storage/collections.ts"
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
