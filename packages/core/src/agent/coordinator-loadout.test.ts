import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import { ensureCoreAgentProfiles } from "./agent-profiles.ts"
import { compileContext } from "./context-compiler.ts"

const previous = process.env.HIVE_DB_PATH

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-loadout-")), "hivedb")
  await ensureHiveDb()
  await ensureCoreAgentProfiles()
})

afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

async function loadoutOf(agentId: string): Promise<string[]> {
  let tools: string[] = []
  await compileContext({
    agentId,
    threadId: `loadout-${agentId}`,
    userMessage: "hola",
    isolated: true,
    skipJev: true,
    onLoadout: loadout => { tools = loadout.tools },
  })
  return tools
}

describe("what each core agent is actually handed", () => {
  // A real run showed BEE looping on report_progress: task_delegate was in its
  // profile, but the coordinator loadout only injected minimal + speckit_* tools.
  test("BEE can delegate and judge: task_delegate, task_revise, task_status", async () => {
    expect(await loadoutOf("bee")).toEqual(expect.arrayContaining(["task_delegate", "task_revise", "task_status"]))
  })

  test("a specialist gets its whole envelope and cannot delegate", async () => {
    const planner = await loadoutOf("planner")
    expect(planner).toEqual(expect.arrayContaining(["speckit_init", "speckit_artifact_write", "speckit_validate"]))
    expect(planner).not.toContain("task_delegate")
    expect(planner).not.toContain("fs_write")
  })
})
