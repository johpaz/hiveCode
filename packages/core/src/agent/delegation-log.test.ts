import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { col } from "../storage/hive.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import type { AgentRunDoc, ToolRunDoc } from "../storage/collections.ts"
import { formatDelegations, listDelegations } from "./delegation-log.ts"

const previousDb = process.env.HIVE_DB_PATH

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-delegations-")), "hivedb")
  await ensureHiveDb()
})

afterAll(() => {
  closeHiveDb()
  if (previousDb === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousDb
})

async function seed(tool: string, args: unknown, extra: Partial<ToolRunDoc> & { runId?: string; agent?: string } = {}) {
  const runId = extra.runId ?? "run-bee"
  const runs = await col<AgentRunDoc>("agentRuns")
  if (!(await runs.get(runId))) {
    await runs.put(runId, { id: runId, task_id: "harness:s:1", thread_id: "t", session_id: "s", agent_id: extra.agent ?? "bee", kind: "harness" } as AgentRunDoc)
  }
  const id = `tr-${Math.random().toString(36).slice(2)}`
  await (await col<ToolRunDoc>("toolRuns")).put(id, {
    id, run_id: runId, task_id: "harness:s:1", tool_name: tool, call_id: id,
    args_json: JSON.stringify(args), result_json: null, status: "completed",
    read_only: false, mutates_workspace: false, mutates_db: false,
    started_at: Date.now(), completed_at: Date.now(), duration_ms: 1500, error: null,
    ...extra,
  } as ToolRunDoc)
}

describe("delegation log", () => {
  test("lists who delegated what, newest first, ignoring other tools", async () => {
    await seed("fs_read", { path: "a.txt" })
    await seed("task_delegate", { worker_id: "builder", specialty: "backend", task_description: "crea el servicio\ncon tests", acceptance: [{ id: "a", description: "x" }, { id: "b", description: "y" }] }, { started_at: 1_000 })
    await seed("task_revise", { ref: "T002", feedback: "falta el test" }, { started_at: 2_000, status: "failed", error: "worker busy" })

    const entries = await listDelegations()

    expect(entries.map(e => e.tool)).toEqual(["task_revise", "task_delegate"])
    expect(entries[1]).toMatchObject({ from: "bee", to: "builder", specialty: "backend", acceptanceCount: 2 })
    expect(entries[1].task).toBe("crea el servicio con tests")
    expect(entries[0]).toMatchObject({ to: "T002", status: "failed", error: "worker busy" })
  })

  test("the specialty drops the worker prefix models like to write", async () => {
    await seed("task_delegate", { worker_id: "builder", specialty: "builder/integration", task_description: "x" })
    expect((await listDelegations())[0].specialty).toBe("integration")
  })

  test("limits and filters by outer task id", async () => {
    for (let i = 0; i < 5; i++) await seed("task_delegate", { worker_id: "scout", task_description: `n${i}` }, { started_at: i + 1 })
    await seed("task_delegate", { worker_id: "spider", task_description: "otra tarea" }, { task_id: "harness:other:9" })

    expect(await listDelegations({ limit: 3 })).toHaveLength(3)
    const only = await listDelegations({ taskId: "other" })
    expect(only).toHaveLength(1)
    expect(only[0].to).toBe("spider")
  })

  test("long descriptions are clipped and unreadable arguments do not break the list", async () => {
    await seed("task_delegate", { worker_id: "builder", task_description: "x".repeat(500) })
    await seed("task_delegate", "not json at all" as unknown as object)
    const entries = await listDelegations()
    expect(entries).toHaveLength(2)
    expect(Math.max(...entries.map(e => e.task.length))).toBeLessThanOrEqual(160)
  })

  test("formats a readable block, and says so when there is nothing", async () => {
    expect(formatDelegations([])).toContain("No hay delegaciones")
    await seed("task_delegate", { worker_id: "verifier", task_description: "verifica los criterios" })
    const text = formatDelegations(await listDelegations())
    expect(text).toContain("bee → verifier")
    expect(text).toContain("verifica los criterios")
    expect(text).toContain("completed")
  })
})
