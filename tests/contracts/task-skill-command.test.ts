import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALL_COMMANDS, parseInternalCommand, type ContextState } from "../../packages/code/src/coordinator/command-parser"
import { col, ensureIndexes } from "../../packages/core/src/storage/hive"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import type { CodeTaskDoc, CodeTaskPhaseDoc, CodeFileSnapshotDoc } from "../../packages/core/src/storage/collections"

const oldPath = process.env.HIVE_DB_PATH
const root = mkdtempSync(join(tmpdir(), "hive-task-skill-"))
const ctx: ContextState = { sessionId: "test", activeProvider: "", activeModel: "", activeMode: "approval", activeMcp: [], activeSkills: [], projectPath: root }
const taskId = "task-12345678"
beforeAll(async () => {
  closeHiveDb(); process.env.HIVE_DB_PATH = join(root, "db")
  await ensureIndexes([["codeFileSnapshots", "task_id"]])
  await (await col<CodeTaskDoc>("codeTasks")).put(taskId, { id: taskId, session_id: "test", description: "Probar tarea", status: "paused", mode: "approval", branch_name: null, pr_url: null, tokens_in: 0, tokens_out: 0, files_changed: 1, lines_added: 0, lines_removed: 0, duration_ms: 0, created_at: "2026-10-07T12:00:00Z", completed_at: null })
  await (await col<CodeTaskPhaseDoc>("codeTaskPhases")).put("phase", { id: "phase", task_id: taskId, phase_name: "build", coordinator: "builder", status: "completed", result_summary: "OK", approved_at: null, approved_by: "user", tokens_in: 0, tokens_out: 0, duration_ms: 0, started_at: null, completed_at: null })
})
afterAll(() => { closeHiveDb(); if (oldPath === undefined) delete process.env.HIVE_DB_PATH; else process.env.HIVE_DB_PATH = oldPath })

test("configuration methods are absent from the slash menu", () => {
  expect(ALL_COMMANDS.filter(c => /^\/(skill|telegram|mcp|mode|provider|modelo)(\s|$)/.test(c.command))).toHaveLength(0)
})
test("task status accepts displayed short IDs and opens a phase viewer", async () => {
  let output = ""
  await parseInternalCommand("/task status 12345678", undefined, ctx, { showInfoModal: async (_title, content) => { output = content } })
  expect(output).toContain(taskId)
  expect(output).toContain("build · builder · completed")
  await parseInternalCommand("/task status", undefined, ctx, { showConfigModal: async (_cmd, _title, fields) => ({ task: fields[0]!.options![0]! }), showInfoModal: async (_title, content) => { output = content } })
  expect(output).toContain("Probar tarea")
})
test("task cancellation detects missing tasks and does not pretend to stop running work", async () => {
  expect((await parseInternalCommand("/task cancel missing", undefined, ctx)).output).toContain("no encontrada")
  const collection = await col<CodeTaskDoc>("codeTasks")
  const row = (await collection.get(taskId))!
  await collection.put(taskId, { ...row.doc, status: "running" })
  expect((await parseInternalCommand("/task cancel 12345678", undefined, ctx)).output).toContain("coordinador no está conectado")
  expect((await collection.get(taskId))!.doc.status).toBe("running")
  await collection.put(taskId, { ...row.doc, status: "paused" })
})
test("rollback restores a snapshot and records rolled_back", async () => {
  const path = join(root, "file.txt")
  await Bun.write(path, "changed")
  await (await col<CodeFileSnapshotDoc>("codeFileSnapshots")).put("snap", { id: "snap", task_id: taskId, file_path: path, content: "original", hash: "test", snapshot_at: "2026-10-07T12:00:00Z" })
  const result = await parseInternalCommand("/task rollback 12345678", undefined, ctx, { showConfigModal: async () => ({ confirm: "Confirmar" }) })
  expect(result.output).toContain("1/1")
  expect(await Bun.file(path).text()).toBe("original")
  expect((await (await col<CodeTaskDoc>("codeTasks")).get(taskId))!.doc.status).toBe("rolled_back")
})
test("skill import opens a file form and details display the full content", async () => {
  const body = "# My Skill\n" + "Detalles completos\n".repeat(40)
  const path = join(root, "SKILL.md")
  await Bun.write(path, body)
  await parseInternalCommand("/skill add", undefined, ctx, { showConfigModal: async () => ({ path }) })
  let output = ""
  await parseInternalCommand("/skill info my_skill", undefined, ctx, { showInfoModal: async (_title, content) => { output = content } })
  expect(output).toContain(body)
  expect(output).toContain("my_skill")
})
