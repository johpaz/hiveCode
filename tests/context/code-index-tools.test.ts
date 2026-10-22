import { beforeEach, afterAll, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { col } from "../../packages/core/src/storage/hive"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { ensureHiveDb } from "../../packages/core/src/storage/bootstrap"
import { projectIdentity } from "../../packages/core/src/agent/project-identity"
import { buildFullIndex } from "../../packages/code/src/agent/code-indexer"
import { outlineTool, findSymbolTool, dependentsTool } from "../../packages/core/src/tools/core/code-index"
import type { CodeSessionDoc } from "../../packages/core/src/storage/collections"

const previous = process.env.HIVE_DB_PATH
let workspace: string
let project: ReturnType<typeof projectIdentity>
const config = () => ({ configurable: { code_session_id: "idx", workspace } })

beforeEach(async () => {
  closeHiveDb()
  const root = mkdtempSync(path.join(tmpdir(), "hive-index-tools-"))
  process.env.HIVE_DB_PATH = path.join(root, "db")
  await ensureHiveDb()
  workspace = path.join(root, "project")
  mkdirSync(path.join(workspace, "src"), { recursive: true })
  project = projectIdentity(workspace)
  writeFileSync(path.join(workspace, "src/store.ts"), [
    "export class Store {",
    "  async load(id: string) {",
    "    const local = id",
    "    return local",
    "  }",
    "}",
    "",
    "export function makeStore() {",
    "  return new Store()",
    "}",
    "",
  ].join("\n"))
  writeFileSync(path.join(workspace, "src/app.ts"), "import { makeStore } from './store'\nexport const app = makeStore()\n")
  await (await col<CodeSessionDoc>("codeSessions")).put("idx", { id: "idx", project_path: workspace, status: "active", created_at: "2026-10-10", last_active: "2026-10-10" })
  await buildFullIndex(project.id, project.root)
})
afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

test("outline lists declarations with line ranges, without the local const", async () => {
  const out = await outlineTool.execute({ path: "src/store.ts" }, config()) as any
  expect(out.ok).toBe(true)
  expect(out.symbols.map((s: any) => `${s.name}@${s.lines}`)).toEqual(["Store@1-6", "Store.load@2-5", "makeStore@8-10"])
  expect(out.stale).toBe(false)
  expect(out.symbols[0].exported).toBe(true)
})

test("outline says so when the file is not indexed", async () => {
  const out = await outlineTool.execute({ path: "src/missing.ts" }, config()) as any
  expect(out.ok).toBe(false)
  expect(out.error).toContain("not in the index")
})

test("find_symbol ranks the exact name first and honours kind", async () => {
  const out = await findSymbolTool.execute({ name: "Store" }, config()) as any
  expect(out.matches[0]).toMatchObject({ path: "src/store.ts", name: "Store", kind: "class", lines: "1-6" })
  expect(out.matches.map((m: any) => m.name)).toContain("makeStore")
  const methods = await findSymbolTool.execute({ name: "load", kind: "method" }, config()) as any
  expect(methods.matches.map((m: any) => m.name)).toEqual(["Store.load"])
})

test("dependents lists who imports a file", async () => {
  const out = await dependentsTool.execute({ path: "src/store.ts" }, config()) as any
  expect(out.imported_by).toEqual(["src/app.ts"])
  const app = await dependentsTool.execute({ path: "src/app.ts" }, config()) as any
  expect(app.imports).toEqual(["src/store.ts"])
})

test("a file edited after indexing is flagged stale", async () => {
  const file = path.join(workspace, "src/store.ts")
  const later = new Date(Date.now() + 60_000)
  utimesSync(file, later, later)
  const out = await outlineTool.execute({ path: "src/store.ts" }, config()) as any
  expect(out.stale).toBe(true)
})

import { refreshSourceIndex } from "../../packages/core/src/agent/source-index"
import { writeFileSync as write } from "node:fs"

test("editing a file keeps the reverse import map, moving only its own edges", async () => {
  // app.ts stops importing store.ts and starts importing util.ts (new file).
  write(path.join(workspace, "src/util.ts"), "export const pad = (s: string) => s\n")
  await refreshSourceIndex(project.id, project.root, project.root, "src/util.ts")
  write(path.join(workspace, "src/app.ts"), "import { pad } from './util'\nexport const app = pad('x')\n")
  await refreshSourceIndex(project.id, project.root, project.root, "src/app.ts")
  const store = await dependentsTool.execute({ path: "src/store.ts" }, config()) as any
  const util = await dependentsTool.execute({ path: "src/util.ts" }, config()) as any
  expect(store.imported_by).toEqual([])
  expect(util.imported_by).toEqual(["src/app.ts"])
})

test("an edit that leaves the imports alone changes no other row", async () => {
  const before = await dependentsTool.execute({ path: "src/store.ts" }, config()) as any
  write(path.join(workspace, "src/app.ts"), "import { makeStore } from './store'\nexport const app = makeStore()\nexport const more = 1\n")
  await refreshSourceIndex(project.id, project.root, project.root, "src/app.ts")
  const after = await dependentsTool.execute({ path: "src/store.ts" }, config()) as any
  expect(after.imported_by).toEqual(before.imported_by)
})

import { reconcileCodeIndex } from "../../packages/code/src/agent/code-indexer"

test("reconcile skips a file whose mtime moved but whose content did not, and the index is fresh again", async () => {
  const file = path.join(workspace, "src/store.ts")
  const later = new Date(Date.now() + 120_000)
  utimesSync(file, later, later)
  expect(((await outlineTool.execute({ path: "src/store.ts" }, config())) as any).stale).toBe(true)
  const result = await reconcileCodeIndex(project.id, project.root)
  expect(result.reindexed).toBe(0)
  expect(((await outlineTool.execute({ path: "src/store.ts" }, config())) as any).stale).toBe(false)
})

test("reconcile reindexes a file whose content changed", async () => {
  const file = path.join(workspace, "src/store.ts")
  write(file, "export function onlyOne() {}\n")
  const later = new Date(Date.now() + 120_000)
  utimesSync(file, later, later)
  expect((await reconcileCodeIndex(project.id, project.root)).reindexed).toBe(1)
  const out = await outlineTool.execute({ path: "src/store.ts" }, config()) as any
  expect(out.symbols.map((s: any) => s.name)).toEqual(["onlyOne"])
})

import { testsForTool } from "../../packages/core/src/tools/core/code-index"

test("tests_for finds the tests that import a file and the one beside it, and maps a test back", async () => {
  write(path.join(workspace, "src/store.test.ts"), "import { Store } from './store'\nexport const t = new Store()\n")
  mkdirSync(path.join(workspace, "tests"), { recursive: true })
  write(path.join(workspace, "tests/app.test.ts"), "import { app } from '../src/app'\nexport const a = app\n")
  await buildFullIndex(project.id, project.root)
  const store = await testsForTool.execute({ path: "src/store.ts" }, config()) as any
  expect(store.tests).toEqual(["src/store.test.ts"])
  const app = await testsForTool.execute({ path: "src/app.ts" }, config()) as any
  expect(app.tests).toEqual(["tests/app.test.ts"])
  const back = await testsForTool.execute({ path: "src/store.test.ts" }, config()) as any
  expect(back).toMatchObject({ kind: "test", covers: ["src/store.ts"] })
  const none = await testsForTool.execute({ path: "src/util.ts" }, config()) as any
  expect(none.ok === false || none.tests?.length === 0).toBe(true)
})
