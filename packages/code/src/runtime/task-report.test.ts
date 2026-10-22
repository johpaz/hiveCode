import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { ensureHiveDb } from "@johpaz/hivecode-core/storage/bootstrap"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { collectRunReport } from "./task-report"

const previous = process.env.HIVE_DB_PATH
let project = ""
const startedAt = Date.now() - 60_000

const run = async (id: string, agent: string, kind: string, status: string, extra: Record<string, unknown> = {}) =>
  (await col<any>("agentRuns")).put(id, { id, task_id: "t", agent_id: agent, kind, status, objective: "x", created_at: Date.now() - 30_000, updated_at: Date.now(), input_tokens: 1000, output_tokens: 100, turn: 3, ...extra }, { expectedVersion: 0 })
const call = async (runId: string, i: number, tool: string, result = "x") =>
  (await col<any>("toolRuns")).put(`${runId}:${i}`, { id: `${runId}:${i}`, run_id: runId, task_id: "t", tool_name: tool, call_id: String(i), args_json: "{}", result_json: result, status: "completed", read_only: true, mutates_workspace: false, mutates_db: false, started_at: Date.now() - 20_000, completed_at: Date.now() - 19_000, duration_ms: 1, error: null }, { expectedVersion: 0 })

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "task-report-")), "db")
  project = mkdtempSync(path.join(tmpdir(), "task-report-proj-"))
  mkdirSync(path.join(project, "src"))
  await ensureHiveDb()
})
afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

describe("collectRunReport", () => {
  test("a coordinator that ran out of budget is a budget failure, not a quiet success", async () => {
    await run("bee-1", "bee", "harness", "needs_budget", { blocker: "task_input_tokens:1500000" })
    await run("scout-1", "scout", "worker", "completed")
    await run("planner-1", "planner", "worker", "needs_budget")
    const { runs } = await collectRunReport({ project, startedAt })
    expect(runs.blocked).toBe(0)
    expect(runs.needsBudget).toBe(2)
    expect(runs.budgetExceeded).toBe(true)
  })

  test("a worker that ran out of budget under a coordinator that finished is not a failure of the task", async () => {
    await run("bee-1", "bee", "harness", "completed")
    await run("scout-1", "scout", "worker", "needs_budget")
    const { runs } = await collectRunReport({ project, startedAt })
    expect(runs.needsBudget).toBe(1)
    expect(runs.budgetExceeded).toBe(false)
  })

  test("reads are split into disk and index calls, per agent", async () => {
    await run("scout-1", "scout", "worker", "completed")
    await call("scout-1", 0, "fs_read", "y".repeat(50)); await call("scout-1", 1, "outline"); await call("scout-1", 2, "search_in_files", "z".repeat(10))
    const { reads } = await collectRunReport({ project, startedAt })
    expect(reads.total).toEqual({ disk: 2, index: 1, diskChars: 60 })
    expect(reads.byAgent.scout).toEqual({ disk: 2, index: 1, diskChars: 60 })
  })
})
