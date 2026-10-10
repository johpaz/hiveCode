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
const SESSION = "session-writeback"

async function seedContextRow() {
  const cache = await col<CodeContextCacheDoc>("codeContextCache")
  await cache.put(`project_context:${SESSION}`, {
    cache_key: `project_context:${SESSION}`,
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

    await markSourceIndexStale(SESSION)

    expect(await cache.get(`project_context:${SESSION}`)).toBeFalsy()
    expect(consumeStaleSourceIndex(SESSION)).toBe(true)
    expect(consumeStaleSourceIndex(SESSION)).toBe(false)
  })

  test("consume is false for a session that was never marked", () => {
    expect(consumeStaleSourceIndex("never-marked")).toBe(false)
  })

  test("refreshSourceIndex indexes an edited file and drops the cached context", async () => {
    const file = path.join(workspace, "src", "a.ts")
    writeFileSync(file, "export const a = 1\n")
    const cache = await seedContextRow()

    await refreshSourceIndex(SESSION, workspace, "src/a.ts")

    const indexed = await (await col<CodeFileDoc>("codeFiles")).get(codeFileId(SESSION, file))
    expect(indexed).toBeTruthy()
    expect(await cache.get(`project_context:${SESSION}`)).toBeFalsy()
  })
})
