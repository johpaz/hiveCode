import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { ensureHiveDb } from "@johpaz/hivecode-core/storage/bootstrap"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeContextCacheDoc, CodeGraphDoc } from "@johpaz/hivecode-core/storage/collections"
import { codeFileId } from "@johpaz/hivecode-core/agent/source-index"
import { flushIndexRebuild, getDependents, updateFileIndex } from "./code-indexer"
import { loadProjectContext } from "./context-retriever"

const previous = process.env.HIVE_DB_PATH
const SESSION = "project-code-writeback"
let workspace = ""

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-cwb-")), "hivedb")
  workspace = mkdtempSync(path.join(tmpdir(), "hivecode-cws-"))
  mkdirSync(path.join(workspace, "src"))
  await ensureHiveDb()
})

afterAll(async () => {
  await flushIndexRebuild(SESSION).catch(() => {})
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

describe("loadProjectContext", () => {
  test("serves the DB row on a cold process and sees its invalidation", async () => {
    const cache = await col<CodeContextCacheDoc>("codeContextCache")
    const key = `project_context:${SESSION}`
    await cache.put(key, {
      cache_key: key,
      compiled: "cached context",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      created_at: new Date().toISOString(),
    }, { expectedVersion: 0 })

    expect(await loadProjectContext(SESSION)).toBe("cached context")

    // refreshSourceIndex invalidates by deleting the row; memory must not outlive it.
    await cache.delete(key)
    expect(await loadProjectContext(SESSION)).toBeNull()
  })

  test("returns null for an expired row", async () => {
    const cache = await col<CodeContextCacheDoc>("codeContextCache")
    const key = `project_context:${SESSION}`
    await cache.put(key, {
      cache_key: key,
      compiled: "old",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString(),
    }, { expectedVersion: 0 })

    expect(await loadProjectContext(SESSION)).toBeNull()
  })
})

describe("updateFileIndex", () => {
  test("defers the reverse-dependency rebuild and getDependents flushes it", async () => {
    const dep = path.join(workspace, "src", "dep.ts")
    const user = path.join(workspace, "src", "user.ts")
    writeFileSync(dep, "export const dep = 1\n")
    writeFileSync(user, `import { dep } from "./dep"\nexport const user = dep\n`)

    await updateFileIndex(SESSION, dep, workspace)
    await updateFileIndex(SESSION, user, workspace)

    // The file rows are written (with paths relative to the root), but exported_by has not been recomputed yet.
    const graph = await col<CodeGraphDoc>("codeGraph")
    const before = await graph.get(codeFileId(SESSION, "src/dep.ts"))
    expect(before).toBeTruthy()
    expect(JSON.parse(before!.doc.exported_by || "[]")).toEqual([])

    // Reading dependents forces the pending rebuild, so the answer is never stale.
    expect(await getDependents(SESSION, "src/dep.ts")).toEqual(["src/user.ts"])
  })
})
