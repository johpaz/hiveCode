import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import { col } from "../storage/hive.ts"
import type { CodeContextCacheDoc, CodeFileDoc } from "../storage/collections.ts"
import { codeFileId, consumeStaleSourceIndex, markSourceIndexStale, refreshSourceIndex } from "./source-index.ts"

const previous = process.env.HIVE_DB_PATH
let workspace = ""
const PROJECT = "project-writeback"

async function seedContextRow() {
  const cache = await col<CodeContextCacheDoc>("codeContextCache")
  await cache.put(`project_context:${PROJECT}`, {
    cache_key: `project_context:${PROJECT}`,
    compiled: "ctx",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
  }, { expectedVersion: 0 })
  return cache
}

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-writeback-")), "hivedb")
  workspace = mkdtempSync(path.join(tmpdir(), "hivecode-ws-"))
  mkdirSync(path.join(workspace, "src"))
  await ensureHiveDb()
})

afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

describe("source index write-back", () => {
  test("markSourceIndexStale is consumed exactly once and drops the cached context", async () => {
    const cache = await seedContextRow()

    await markSourceIndexStale(PROJECT)

    expect(await cache.get(`project_context:${PROJECT}`)).toBeFalsy()
    expect(consumeStaleSourceIndex(PROJECT)).toBe(true)
    expect(consumeStaleSourceIndex(PROJECT)).toBe(false)
  })

  test("consume is false for a project that was never marked", () => {
    expect(consumeStaleSourceIndex("never-marked")).toBe(false)
  })

  test("refreshSourceIndex indexes an edited file and drops the cached context", async () => {
    writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1\n")
    const cache = await seedContextRow()

    expect(await refreshSourceIndex(PROJECT, workspace, workspace, "src/a.ts")).toBe(true)

    const indexed = await (await col<CodeFileDoc>("codeFiles")).get(codeFileId(PROJECT, "src/a.ts"))
    expect(indexed).toBeTruthy()
    expect(indexed!.doc.file_path).toBe("src/a.ts")
    // The index keeps symbols, not the text of the file.
    expect(indexed!.doc.content).toBeUndefined()
    expect(await cache.get(`project_context:${PROJECT}`)).toBeFalsy()
  })

  test("an edit made in a worktree does not touch the project's index", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "hivecode-worktree-"))
    mkdirSync(path.join(other, "src"))
    writeFileSync(path.join(other, "src", "a.ts"), "export const a = 2\n")

    expect(await refreshSourceIndex(PROJECT, workspace, other, "src/a.ts")).toBe(false)
    expect(await (await col<CodeFileDoc>("codeFiles")).get(codeFileId(PROJECT, "src/a.ts"))).toBeUndefined()
  })
})
