import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseInternalCommand, type ContextState } from "../../packages/code/src/coordinator/command-parser"
import { col } from "../../packages/core/src/storage/hive"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { ensureHiveDb } from "../../packages/core/src/storage/bootstrap"
import { MAX_PROJECT_NOTES, projectIdentity } from "../../packages/core/src/agent/project-identity"
import type { CodeProjectDoc } from "../../packages/core/src/storage/collections"

const oldPath = process.env.HIVE_DB_PATH
const root = mkdtempSync(join(tmpdir(), "hive-project-cmd-"))
const repo = join(root, "app")
const ctx: ContextState = { sessionId: "test", activeProvider: "", activeModel: "", activeMode: "approval", activeMcp: [], activeSkills: [], projectPath: repo }

beforeAll(async () => {
  closeHiveDb(); process.env.HIVE_DB_PATH = join(root, "db")
  await ensureHiveDb()
  mkdirSync(repo)
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "cmd-app" }))
})
afterAll(() => { closeHiveDb(); if (oldPath === undefined) delete process.env.HIVE_DB_PATH; else process.env.HIVE_DB_PATH = oldPath })

const stored = async () => (await (await col<CodeProjectDoc>("codeProjects")).get(projectIdentity(repo).id))?.doc

test("/project shows the project and says there are no notes yet", async () => {
  const out = (await parseInternalCommand("/project", undefined, ctx)).output
  expect(out).toContain("Proyecto: cmd-app")
  expect(out).toContain("Sin notas")
})

test("/project notes <text> stores the notes, and replaces them the next time", async () => {
  expect((await parseInternalCommand("/project notes Responde en español", undefined, ctx)).output).toContain("guardadas")
  expect((await stored())!.notes).toBe("Responde en español")
  await parseInternalCommand("/project notes No toques legacy/", undefined, ctx)
  expect((await stored())!.notes).toBe("No toques legacy/")
  expect((await parseInternalCommand("/project", undefined, ctx)).output).toContain("No toques legacy/")
})

test("without text it opens a form, and cancelling changes nothing", async () => {
  expect((await parseInternalCommand("/project notes", undefined, ctx, { showConfigModal: async () => ({ notes: "Desde el formulario" }) })).output).toContain("guardadas")
  expect((await stored())!.notes).toBe("Desde el formulario")
  expect((await parseInternalCommand("/project notes", undefined, ctx, { showConfigModal: async () => null })).output).toContain("cancelada")
  expect((await stored())!.notes).toBe("Desde el formulario")
})

test("notes too long for every agent's context are refused, and --clear empties them", async () => {
  const refused = (await parseInternalCommand(`/project notes ${"x".repeat(MAX_PROJECT_NOTES + 1)}`, undefined, ctx)).output
  expect(refused).toContain("máximo")
  expect((await stored())!.notes).toBe("Desde el formulario")
  expect((await parseInternalCommand("/project notes --clear", undefined, ctx)).output).toContain("borradas")
  expect((await stored())!.notes).toBe("")
})

test("/project reindex reconciles the index", async () => {
  expect((await parseInternalCommand("/project reindex", undefined, ctx)).output).toContain("Índice al día")
})
