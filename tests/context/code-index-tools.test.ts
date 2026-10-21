import { beforeEach, afterAll, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { col } from "../../packages/core/src/storage/hive"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { ensureHiveDb } from "../../packages/core/src/storage/bootstrap"
import { buildFullIndex } from "../../packages/code/src/agent/code-indexer"
import { outlineTool, findSymbolTool, dependentsTool } from "../../packages/core/src/tools/core/code-index"
import type { CodeSessionDoc } from "../../packages/core/src/storage/collections"

const previous = process.env.HIVE_DB_PATH
let workspace: string
const config = () => ({ configurable: { code_session_id: "idx", workspace } })

beforeEach(async () => {
  closeHiveDb()
  const root = mkdtempSync(path.join(tmpdir(), "hive-index-tools-"))
  process.env.HIVE_DB_PATH = path.join(root, "db")
  await ensureHiveDb()
  workspace = path.join(root, "project")
  mkdirSync(path.join(workspace, "src"), { recursive: true })
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
  await buildFullIndex("idx", workspace)
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
