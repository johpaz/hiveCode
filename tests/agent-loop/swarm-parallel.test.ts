/**
 * The swarm, through the real loop: BEE delegates to `builder` and to its instance `builder#2` in ONE
 * step; the second depends on the first (`after`), so it parks without starting a run, then receives
 * the first one's handoff. The instance works in the private workspace the swarm runtime gave it and
 * its work is merged when it finishes. Only the model is scripted.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { runAgent } from "@johpaz/hivecode-core/agent/agent-loop"
import { registerSwarmRuntime } from "@johpaz/hivecode-core/agent/swarm-runtime"
import { setExecutionMode } from "@johpaz/hivecode-core/agent/execution-mode"
import { resetDelegationBoard } from "@johpaz/hivecode-core/agent/delegation-board"
import type { AgentRunDoc } from "@johpaz/hivecode-core/storage/collections"
import { cleanupApiKey, isolateHiveDb, restoreDbPath, seedApiKey, seedFixture, startFakeModel, type FakeModel } from "../e2e/helpers"

let model: FakeModel | null = null
const previousHome = process.env.HIVE_HOME
beforeEach(async () => { isolateHiveDb(); await seedApiKey(); process.env.HIVE_HOME = mkdtempSync(path.join(tmpdir(), "hivecode-home-")); setExecutionMode("auto") })
afterEach(async () => { if (previousHome === undefined) delete process.env.HIVE_HOME; else process.env.HIVE_HOME = previousHome; await Bun.sleep(20); model?.stop(); model = null; registerSwarmRuntime(null); resetDelegationBoard() })
afterAll(async () => { await cleanupApiKey(); restoreDbPath() })

const text = (req: { messages: Array<Record<string, unknown>> }) => JSON.stringify(req.messages)
const isBee = (req: { messages: Array<Record<string, unknown>> }) => String(req.messages[0]?.content ?? "").includes("Eres BEE")

async function giveBeeDelegation() {
  const agents = await col<any>("agents")
  const bee = (await agents.get("bee"))!
  await agents.put("bee", { ...bee.doc, tools_json: JSON.stringify([...JSON.parse(bee.doc.tools_json), "task_delegate", "task_revise", "task_status"]) }, { expectedVersion: bee.version })
}

test("builder and builder#2 run in parallel; the dependent one waits, then gets the handoff; the merge happens per instance", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "hive-swarm-loop-"))
  const prepared: string[] = []
  const integrated: string[] = []
  registerSwarmRuntime({
    prepare: async ({ instanceId }) => { prepared.push(instanceId); return sandbox },
    integrate: async ({ instanceId }) => { integrated.push(instanceId); return { status: "integrated", files: ["web.txt"] } },
    cleanup: async () => {},
  })

  const base = mkdtempSync(path.join(tmpdir(), "hive-swarm-base-"))
  let beeTurns = 0
  model = startFakeModel((_turn, req) => {
    if (isBee(req)) {
      beeTurns++
      return beeTurns === 1
        ? { toolCalls: [
            { name: "task_delegate", args: { worker_id: "builder", ref: "T001", task_description: "API: expón /items", acceptance: [{ id: "a", description: "hecho" }] } },
            { name: "task_delegate", args: { worker_id: "builder#2", ref: "T002", after: ["T001"], task_description: "FRONT: consume la API", acceptance: [{ id: "a", description: "hecho" }] } },
          ] }
        : { content: "Plan completo." }
    }
    const t = text(req)
    const isFront = t.includes("FRONT")
    const sawTool = req.messages.some(m => m.role === "tool")
    if (isFront && !sawTool) return { toolCalls: [{ name: "fs_write", args: { path: "web.txt", content: "front" } }] }
    return { content: isFront ? "front listo" : "api lista: GET /items" }
  })
  await seedFixture({ baseUrl: model.baseUrl })
  await giveBeeDelegation()

  const chunks: any[] = []
  for await (const c of runAgent({ agentId: "bee", userMessage: "haz la app", threadId: "thread-swarm", workspace: base })) chunks.push(c)

  expect(chunks.find(c => c.run)?.run?.status).toBe("completed")
  // The instance was cloned from the base profile and ran in the runtime's private workspace.
  expect(prepared).toEqual(["builder#2"])
  expect(integrated).toEqual(["builder#2"])
  expect(existsSync(path.join(sandbox, "web.txt"))).toBe(true)
  expect(readFileSync(path.join(sandbox, "web.txt"), "utf-8")).toBe("front")

  // T002's brief carries T001's handoff: it started only after T001 had finished.
  const frontRequest = model.requests.find(r => !isBee(r) && text(r).includes("FRONT"))!
  expect(text(frontRequest)).toContain("api lista: GET /items")
  expect(text(frontRequest)).toContain("de las que depende")

  // Each delegation is its own run, with its own thread (so a revision resumes the right one).
  const runs = (await (await col<AgentRunDoc>("agentRuns")).scan()).map(e => e.doc).filter(r => r.kind === "worker")
  expect(runs.map(r => r.agent_id).sort()).toEqual(["builder", "builder#2"])
  const api = runs.find(r => r.agent_id === "builder")!
  const front = runs.find(r => r.agent_id === "builder#2")!
  expect(front.thread_id).not.toBe(api.thread_id)
}, 30_000)

test("a dependency that failed comes back to BEE as blocked_by instead of starting the dependent worker", async () => {
  let beeTurns = 0
  model = startFakeModel((_turn, req) => {
    if (isBee(req)) {
      beeTurns++
      return beeTurns === 1
        ? { toolCalls: [
            { name: "task_delegate", args: { worker_id: "scout", ref: "T001", task_description: "investiga", acceptance: [{ id: "a", description: "hecho" }] } },
            { name: "task_delegate", args: { worker_id: "builder", ref: "T002", after: ["T001"], task_description: "FRONT: usa T001" } },
          ] }
        : { content: "Reviso el bloqueo." }
    }
    // The scout's model call fails: the whole run errors, T001 settles as failed.
    return { content: "", finishReason: "length" }
  })
  await seedFixture({ baseUrl: model.baseUrl })
  await giveBeeDelegation()

  const chunks: any[] = []
  for await (const c of runAgent({ agentId: "bee", userMessage: "haz la app", threadId: "thread-swarm-fail" })) chunks.push(c)

  const toolMessages = chunks.flatMap(c => c.tools?.messages?.map((m: any) => String(m.content ?? "")) ?? [])
  const dependent = toolMessages.find(m => m.includes("blocked_by"))
  // The builder never ran: no worker request mentions FRONT.
  expect(model.requests.some(r => !isBee(r) && text(r).includes("FRONT"))).toBe(false)
  expect(dependent).toBeDefined()
  expect(dependent).toContain("T001")
}, 30_000)
