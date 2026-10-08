import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import { ensureCoreAgentProfiles } from "./agent-profiles.ts"
import { structuralParallelism } from "./jev-planner.ts"

const previous = process.env.HIVE_DB_PATH

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-parallel-")), "hivedb")
  await ensureHiveDb()
  await ensureCoreAgentProfiles()
})

afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

const delegate = (worker_id: string) => ({ function: { name: "task_delegate", arguments: JSON.stringify({ worker_id, task_description: "x" }) } })
const call = (name: string) => ({ function: { name, arguments: "{}" } })

describe("structural parallelism (no oracle needed)", () => {
  test("a single call is not a batch", async () => {
    expect(await structuralParallelism([delegate("scout")])).toBeUndefined()
  })

  test("independent reads run together", async () => {
    expect(await structuralParallelism([call("fs_read"), call("web_search")])).toEqual({ kind: "reads", safe: true })
  })

  test("a read mixed with a write stays sequential", async () => {
    expect(await structuralParallelism([call("fs_read"), call("fs_write")])).toBeUndefined()
  })

  test("read-only workers plus one writer run together", async () => {
    expect(await structuralParallelism([delegate("scout"), delegate("spider"), delegate("builder")]))
      .toEqual({ kind: "delegations", safe: true })
  })

  test("the same worker twice is not parallel", async () => {
    expect(await structuralParallelism([delegate("scout"), delegate("scout")])).toEqual({ kind: "delegations", safe: false })
  })

  test("an unknown worker is not parallel", async () => {
    expect(await structuralParallelism([delegate("scout"), delegate("ghost")])).toEqual({ kind: "delegations", safe: false })
  })
})
