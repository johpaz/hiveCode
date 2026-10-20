/**
 * The loop detector against the real loop: repeating a call is a stall only if nothing changed
 * between the repetitions. A builder that runs the same check after each fix is working, and used
 * to be stopped on the fourth run (12 of 31 worker runs in one real session ended that way).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { runAgent, type StreamChunk } from "@johpaz/hivecode-core/agent/agent-loop"
import { setExecutionMode } from "@johpaz/hivecode-core/agent/execution-mode"
import { MINIMAL_TOOLS, PROVIDER_ID, SECRET_SERVICE, previousDbPath, seedFixture, startFakeModel, type FakeModel } from "../e2e/helpers"

let model: FakeModel | null = null
let workspace = ""
const previousHome = process.env.HIVE_HOME

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-repeat-")), "hivedb")
  process.env.HIVE_HOME = mkdtempSync(path.join(tmpdir(), "hivecode-repeat-home-"))
  workspace = mkdtempSync(path.join(tmpdir(), "hivecode-repeat-ws-"))
  writeFileSync(path.join(workspace, "estado.txt"), "v0\n")
  setExecutionMode("auto")
  await Bun.secrets.set({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}`, value: "sk-e2e-fake" })
})

afterEach(async () => {
  await Bun.sleep(20)
  model?.stop()
  model = null
})

afterAll(async () => {
  closeHiveDb()
  try { await Bun.secrets.delete({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}` }) } catch { /* gone */ }
  if (previousDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousDbPath
  if (previousHome === undefined) delete process.env.HIVE_HOME
  else process.env.HIVE_HOME = previousHome
})

async function drive(script: Parameters<typeof startFakeModel>[0], thread: string) {
  model = startFakeModel(script)
  await seedFixture({ baseUrl: model.baseUrl })
  const agents = await col<any>("agents")
  const builder = await agents.get("builder")
  await agents.put("builder", { ...builder!.doc, max_iterations: 40, tools_json: JSON.stringify([...MINIMAL_TOOLS, "fs_write", "fs_read"]) }, { expectedVersion: builder!.version })
  const chunks: StreamChunk[] = []
  for await (const chunk of runAgent({ agentId: "builder", userMessage: "itera", threadId: thread, workspace, maxSteps: 40 })) chunks.push(chunk)
  return { run: chunks.find(c => c.run)?.run, toolResults: chunks.flatMap(c => c.tools?.messages?.map((m: any) => String(m.content ?? "")) ?? []) }
}

const READ = { name: "fs_read", args: { path: "estado.txt" } }

describe("repeating a call", () => {
  test("is fine when the workspace changed in between", async () => {
    // read, write, read, write, ... the same read six times, each after an edit.
    const { run, toolResults } = await drive(turn => {
      if (turn > 12) return { content: "Todo verificado." }
      return turn % 2 === 1
        ? { content: "", toolCalls: [READ] }
        : { content: "", toolCalls: [{ name: "fs_write", args: { path: "estado.txt", content: `v${turn}\n` } }] }
    }, "t-progress")

    expect(run?.status).toBe("completed")
    expect(run?.blocker).toBeNull()
    expect(toolResults).toHaveLength(12)
    expect(readFileSync(path.join(workspace, "estado.txt"), "utf-8")).toBe("v12\n")
  })

  test("still stops when nothing changes between the repetitions", async () => {
    const { run } = await drive(turn => turn <= 8 ? { content: "", toolCalls: [READ] } : { content: "fin" }, "t-stall")

    expect(run?.status).toBe("blocked")
    expect(run?.blocker).toBe("repeated_tool_call:fs_read")
    expect(existsSync(path.join(workspace, "estado.txt"))).toBe(true)
  })
})
