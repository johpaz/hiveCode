/**
 * Per-tool confirmation in `approval` mode, through the real agent loop.
 *
 * Only the model is substituted (a scripted OpenAI-compatible server). The loop, the mode check,
 * the confirmation request, the tool and the filesystem are real. The "person" is a requester
 * registered the way the TUI launcher registers its own.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { runAgent, type StreamChunk } from "@johpaz/hivecode-core/agent/agent-loop"
import { setExecutionMode } from "@johpaz/hivecode-core/agent/execution-mode"
import {
  registerToolApprovalRequester, resolveToolApproval, type ToolApprovalRequest,
} from "@johpaz/hivecode-core/agent/tool-approval"
import { MINIMAL_TOOLS, PROVIDER_ID, SECRET_SERVICE, previousDbPath, seedFixture, startFakeModel, type FakeModel } from "../e2e/helpers"

let model: FakeModel | null = null
let workspace = ""
const previousHome = process.env.HIVE_HOME
const asked: ToolApprovalRequest[] = []

/** The person: answers each request with whatever `decide` returns. */
function personAnswers(decide: (request: ToolApprovalRequest) => boolean) {
  registerToolApprovalRequester(request => {
    asked.push(request)
    queueMicrotask(() => resolveToolApproval(request.request_id, decide(request)))
  })
}

async function runTurn(toolName: string, args: Record<string, unknown>, thread: string) {
  model = startFakeModel(turn =>
    turn === 1 ? { content: "", toolCalls: [{ name: toolName, args }] } : { content: "terminado" })
  await seedFixture({ baseUrl: model.baseUrl })
  // The builder needs the shell as well as fs_write.
  const agents = await col<any>("agents")
  const builder = await agents.get("builder")
  await agents.put("builder", { ...builder!.doc, tools_json: JSON.stringify([...MINIMAL_TOOLS, "fs_write", "fs_read", "shell_executor"]) }, { expectedVersion: builder!.version })

  const chunks: StreamChunk[] = []
  for await (const chunk of runAgent({
    agentId: "builder", userMessage: "haz el cambio", threadId: thread, workspace,
  })) chunks.push(chunk)
  return chunks.flatMap(c => c.tools?.messages?.map((m: any) => String(m.content ?? "")) ?? [])
}

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-approval-")), "hivedb")
  process.env.HIVE_HOME = mkdtempSync(path.join(tmpdir(), "hivecode-home-"))
  workspace = mkdtempSync(path.join(tmpdir(), "hivecode-approval-ws-"))
  setExecutionMode("approval")
  asked.length = 0
  await Bun.secrets.set({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}`, value: "sk-e2e-fake" })
})

afterEach(async () => {
  registerToolApprovalRequester(null)
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

describe("approval mode asks before a tool writes", () => {
  test("an approved fs_write runs, and the person saw the arguments", async () => {
    personAnswers(() => true)
    const results = await runTurn("fs_write", { path: "hola.txt", content: "hola" }, "t-approve")

    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ agent: "builder", tool: "fs_write" })
    expect(asked[0].detail).toContain("hola.txt")
    expect(existsSync(path.join(workspace, "hola.txt"))).toBe(true)
    expect(readFileSync(path.join(workspace, "hola.txt"), "utf-8")).toBe("hola")
    expect(results.join("\n")).not.toContain("CANCELADO")
  })

  test("a declined fs_write does not run, and the model is told not to retry", async () => {
    personAnswers(() => false)
    const results = await runTurn("fs_write", { path: "hola.txt", content: "hola" }, "t-decline")

    expect(asked).toHaveLength(1)
    expect(existsSync(path.join(workspace, "hola.txt"))).toBe(false)
    expect(results.join("\n")).toContain("CANCELADO")
    expect(results.join("\n")).toContain("No la repitas")
  })

  test("a shell command that writes asks; the same shell reading does not", async () => {
    personAnswers(() => false)
    await runTurn("shell_executor", { cmd: "echo hola > hola.txt" }, "t-shell-write")
    expect(asked.map(a => a.tool)).toEqual(["shell_executor"])
    expect(existsSync(path.join(workspace, "hola.txt"))).toBe(false)

    asked.length = 0
    model?.stop()
    closeHiveDb()
    process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-approval-")), "hivedb")
    personAnswers(() => false)
    await runTurn("shell_executor", { cmd: "ls -la" }, "t-shell-read")
    expect(asked).toHaveLength(0)
  })

  test("with nobody to ask (no requester, not a terminal) the tool is refused, not left waiting", async () => {
    // No requester registered and stdin is not a TTY under `bun test`.
    const results = await runTurn("fs_write", { path: "hola.txt", content: "hola" }, "t-nobody")

    expect(existsSync(path.join(workspace, "hola.txt"))).toBe(false)
    expect(results.join("\n")).toContain("APPROVAL REQUIRED")
  })

  test("auto mode never asks", async () => {
    setExecutionMode("auto")
    personAnswers(() => false)
    await runTurn("fs_write", { path: "hola.txt", content: "hola" }, "t-auto")

    expect(asked).toHaveLength(0)
    expect(existsSync(path.join(workspace, "hola.txt"))).toBe(true)
  })

  test("an execution the harness already approved does not ask again", async () => {
    personAnswers(() => false)
    model = startFakeModel(turn => turn === 1
      ? { content: "", toolCalls: [{ name: "fs_write", args: { path: "hola.txt", content: "hola" } }] }
      : { content: "terminado" })
    await seedFixture({ baseUrl: model.baseUrl })
    for await (const _ of runAgent({ agentId: "builder", userMessage: "x", threadId: "t-approved", workspace, approvedExecution: true })) { /* drain */ }

    expect(asked).toHaveLength(0)
    expect(existsSync(path.join(workspace, "hola.txt"))).toBe(true)
  })
})
