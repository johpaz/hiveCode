import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import { col } from "../storage/hive.ts"
import type { ToolRunDoc } from "../storage/collections.ts"
import { MAX_STORED_PAYLOAD_CHARS, capStoredPayload, recordCompletedToolRun } from "./tracer.ts"

const previous = process.env.HIVE_DB_PATH

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-tracer-")), "hivedb")
  await ensureHiveDb()
})

afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

describe("capStoredPayload", () => {
  test("leaves a small payload untouched", () => {
    expect(capStoredPayload("hola")).toBe("hola")
  })

  test("cuts the middle of an oversized payload and names its sha256", () => {
    const big = `START${"x".repeat(MAX_STORED_PAYLOAD_CHARS * 2)}END`
    const capped = capStoredPayload(big)
    expect(capped.length).toBeLessThanOrEqual(MAX_STORED_PAYLOAD_CHARS)
    expect(capped.startsWith("START")).toBe(true)
    expect(capped.endsWith("END")).toBe(true)
    expect(capped).toMatch(/sha256:[0-9a-f]{16}/)
  })
})

describe("recordCompletedToolRun", () => {
  test("stores full args and result and returns the linkable id", async () => {
    const id = await recordCompletedToolRun({
      runId: "code:s1:t1", taskId: "t1", callId: "c1", toolName: "fs_edit",
      args: { path: "a.ts", content: "y".repeat(5_000) },
      result: { ok: true, diff: "z".repeat(5_000) },
      success: true, durationMs: 1500, mutatesWorkspace: true,
    })

    expect(id).toBe("code:s1:t1:c1")
    const row = await (await col<ToolRunDoc>("toolRuns")).get(id!)
    expect(row?.doc.status).toBe("completed")
    expect(row?.doc.mutates_workspace).toBe(true)
    expect(row?.doc.result_json?.length).toBeGreaterThan(5_000)
    expect(JSON.parse(row!.doc.args_json).path).toBe("a.ts")
  })

  test("marks a failed call and records the error", async () => {
    const id = await recordCompletedToolRun({
      runId: "code:s1:t2", taskId: "t2", callId: "c1", toolName: "shell_executor",
      args: { cmd: "false" }, result: { ok: false, error: "exit 1" }, success: false, durationMs: 10,
    })
    const row = await (await col<ToolRunDoc>("toolRuns")).get(id!)
    expect(row?.doc.status).toBe("failed")
    expect(row?.doc.error).toContain("exit 1")
  })
})
