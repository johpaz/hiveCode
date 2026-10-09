import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../../storage/hivedb.ts"
import { ensureHiveDb } from "../../storage/bootstrap.ts"
import { col } from "../../storage/hive.ts"
import type { TaskDoc } from "../../storage/collections.ts"
import { ensureCoreAgentProfiles } from "../../agent/agent-profiles.ts"
import { taskReviseTool } from "./index.ts"

const previous = process.env.HIVE_DB_PATH

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-revise-")), "hivedb")
  await ensureHiveDb()
  await ensureCoreAgentProfiles()
})

afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

async function putTask(id: string, patch: Partial<TaskDoc>): Promise<void> {
  const now = Date.now()
  await (await col<TaskDoc>("tasks")).put(id, {
    id, project_id: "", agent_id: "ghost", parent_task_id: "", name: "n", description: "d", status: "completed",
    progress: 100, priority: 0, depends_on: null, result: "r", error: null, metadata: null,
    created_at: now, updated_at: now, completed_at: now, ...patch,
  }, { expectedVersion: 0 })
}

describe("task_revise finds the task the coordinator names", () => {
  test("an unknown id explains which id to use", async () => {
    const result = await taskReviseTool.execute({ task_id: "T003", feedback: "fix it" }) as any
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Task not found: T003")
    expect(result.error).toContain("task_id that task_delegate returned")
  })

  test("a Spec Kit ref resolves to the delegated task, reaching its worker check", async () => {
    await putTask("000000000000007", { metadata: JSON.stringify({ worker_id: "ghost", ref: "T003" }) })
    const result = await taskReviseTool.execute({ task_id: "t003", feedback: "fix it" }) as any
    // Past the lookup: the failure is now about the worker, not about the task.
    expect(result.error).toContain("Worker unavailable for task 000000000000007")
  })

  test("the newest delegation wins when a ref is reused", async () => {
    await putTask("000000000000001", { created_at: 1, metadata: JSON.stringify({ worker_id: "ghost", ref: "T001" }) })
    await putTask("000000000000002", { created_at: 2, metadata: JSON.stringify({ worker_id: "ghost", ref: "T001" }) })
    const result = await taskReviseTool.execute({ task_id: "T001", feedback: "again" }) as any
    expect(result.error).toContain("task 000000000000002")
  })
})
