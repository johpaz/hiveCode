import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../../storage/hivedb.ts"
import { ensureHiveDb } from "../../storage/bootstrap.ts"
import { ensureCoreAgentProfiles } from "../../agent/agent-profiles.ts"
import { taskDelegateTool } from "./index.ts"

const previous = process.env.HIVE_DB_PATH

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-delegate-")), "hivedb")
  await ensureHiveDb()
  await ensureCoreAgentProfiles()
})

afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

describe("task_delegate context", () => {
  test("is a documented parameter", () => {
    expect((taskDelegateTool.parameters as any).properties.context.type).toBe("string")
  })

  test("refuses a context that is the text of files, with a way out", async () => {
    const result = await taskDelegateTool.execute({ worker_id: "scout", task_description: "map the harness", context: "x".repeat(8001) }) as any
    expect(result.ok).toBe(false)
    expect(result.error).toContain("max 8000")
    expect(result.error).toContain("line ranges")
  })
})
