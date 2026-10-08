import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseInternalCommand, type ContextState } from "../../packages/code/src/coordinator/command-parser"
import { col } from "../../packages/core/src/storage/hive"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import type { CodeNarrativeDoc } from "../../packages/core/src/storage/collections"

const oldPath = process.env.HIVE_DB_PATH
const root = mkdtempSync(join(tmpdir(), "hive-narrative-"))
const ctx: ContextState = { sessionId: "current", activeProvider: "", activeModel: "", activeMode: "approval", activeMcp: [], activeSkills: [], projectPath: root }
const full = "Inicio de evento " + "detalle ".repeat(40) + "ERROR FINAL"
beforeAll(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = join(root, "db")
  const collection = await col<CodeNarrativeDoc>("codeNarrative")
  for (const [id, session, entry] of [["1", "current", full], ["2", "other", "OTRA SESIÓN"]]) {
    await collection.put(id!, { id: id!, session_id: session!, task_id: "task", coordinator: "builder", phase: "build", entry: entry!, is_draft: false, is_override: false, created_at: "2026-10-07T12:00:00Z" })
  }
})
afterAll(() => { closeHiveDb(); if (oldPath === undefined) delete process.env.HIVE_DB_PATH; else process.env.HIVE_DB_PATH = oldPath })

test("narrative opens a full session-scoped viewer from any TUI tab", async () => {
  let output = ""
  await parseInternalCommand("/narrative show", undefined, ctx, { showInfoModal: async (_title, content) => { output = content } })
  expect(output).toContain(full)
  expect(output).not.toContain("OTRA SESIÓN")
  const all = await parseInternalCommand("/narrative show --all", undefined, ctx)
  expect(all.output).toContain("OTRA SESIÓN")
})
test("search without arguments prompts and finds untruncated text", async () => {
  let output = ""
  await parseInternalCommand("/narrative search", undefined, ctx, {
    showConfigModal: async () => ({ query: "ERROR FINAL" }),
    showInfoModal: async (_title, content) => { output = content },
  })
  expect(output).toContain(full)
  expect(output).toContain("1 de 1")
  expect((await parseInternalCommand("/narrative show --last nope", undefined, ctx)).output).toContain("entre 1 y 200")
})
test("JSON export is real JSON and only includes the selected session", async () => {
  let output = ""
  await parseInternalCommand("/narrative export --format json", undefined, ctx, { showInfoModal: async (_title, content) => { output = content } })
  const file = output.split("\n").at(-1)!
  const rows = await Bun.file(file).json()
  expect(rows).toHaveLength(1)
  expect(rows[0].entry).toBe(full)
  expect(rows[0].session_id).toBe("current")
})
