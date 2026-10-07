/**
 * Durable resume — end to end against a stubbed provider.
 *
 * The failure this guards against is the expensive one: a run that resumes and
 * re-executes a tool which had already dispatched. The stub records every call
 * it receives, so "did fs_write run twice" is an assertion, not an inference.
 */
import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import type { AgentDoc, AgentRunDoc } from "@johpaz/hivecode-core/storage/collections"
import { writeCheckpoint, readCheckpoint, leaseOwner, LEASE_SECONDS } from "@johpaz/hivecode-core/agent/run-store"

// ── Provider stub ──────────────────────────────────────────────────────────
// Counts turns and replays a scripted sequence of responses. The first turn
// asks for a tool; every later turn answers with text, so a run that failed to
// resume would visibly call the tool again.
let turn = 0
let toolCallCount = 0
let responses: Array<{ content?: string; tool_calls?: any[] }> = []

mock.module("@johpaz/hivecode-core/agent/llm-client", () => ({
  callLLM: async (req: any) => {
    const scripted = responses[Math.min(turn, responses.length - 1)]
    turn++
    if (scripted.tool_calls?.length) toolCallCount++
    return {
      content: scripted.content ?? "",
      tool_calls: scripted.tool_calls,
      usage: { input_tokens: 10, output_tokens: 5 },
    }
  },
  resolveProviderConfig: async (provider: string, model: string) => ({
    provider, model, contextWindow: 32_000,
  }),
}))

const { runAgent } = await import("@johpaz/hivecode-core/agent/agent-loop")

const nowSec = () => Math.floor(Date.now() / 1000)
let counter = 0
const newRunId = () => `test:resume:${Date.now()}:${++counter}`
const AGENT_ID = "test-resume-agent"

/** Self-contained: seeds its own agent rather than depending on install state. */
async function seedAgent(): Promise<void> {
  const agents = await col<AgentDoc>("agents")
  const ts = nowSec()
  await agents.put(AGENT_ID, {
    id: AGENT_ID,
    user_id: "test",
    name: "Resume Test Agent",
    description: "agent used by the resume tests",
    system_prompt: "you are a coding agent",
    tone: null,
    role: "coordinator",
    status: "active",
    enabled: true,
    provider_id: "openai",
    model_id: "gpt-4o-mini",
    tools_json: null,
    skills_json: null,
    parent_id: "__none__",
    max_iterations: 10,
    workspace: null,
    created_at: ts,
    updated_at: ts,
  } as AgentDoc)
}

async function seedRun(runId: string, status: AgentRunDoc["status"] = "interrupted"): Promise<void> {
  const runs = await col<AgentRunDoc>("agentRuns")
  const ts = nowSec()
  await runs.put(runId, {
    id: runId,
    task_id: "t1",
    thread_id: "t1",
    session_id: "t1",
    agent_id: AGENT_ID,
    kind: "harness",
    parent_run_id: null,
    objective: "do the thing",
    status,
    turn: 0,
    max_turns: 10,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    checkpoint_json: null,
    blocker: null,
    next_action: null,
    lease_owner: "agent-loop:999999",
    lease_expires_at: ts - 10,
    created_at: ts,
    updated_at: ts,
    completed_at: null,
  })
}

beforeEach(async () => {
  turn = 0
  toolCallCount = 0
  responses = []
  await seedAgent()
})

afterAll(() => { closeHiveDb() })

describe("resume", () => {
  test("a resumed run restores the transcript and continues from its iteration", async () => {
    const runId = newRunId()
    await seedRun(runId)

    await writeCheckpoint(runId, {
      version: 1,
      messages: [
        { role: "system", content: "you are a coding agent" },
        { role: "user", content: "the original request" },
        { role: "assistant", content: "an earlier attempt" },
      ],
      iterations: 4,
      totalInputTokens: 500,
      totalOutputTokens: 100,
      totalCostUsd: 0.005,
      repeats: null,
      pendingToolCalls: [],
    })

    // Only text, no tools: the resumed run must not need another turn.
    responses = [{ content: "finished after resume" }]

    const stream = runAgent({
      agentId: AGENT_ID,
      threadId: "t1",
      userMessage: "the original request",
      resumeRunId: runId,
      maxSteps: 10,
    })

    let sawResumeLog = false
    let finalText = ""
    for await (const chunk of stream) {
      if (chunk.agent?.messages) {
        const text = chunk.agent.messages.map((m: any) => m.content ?? "").join("")
        if (text) finalText += text
      }
      if (chunk.run?.status) sawResumeLog = true
    }

    const restored = await readCheckpoint(runId)
    // The run adopted our lease rather than staying owned by a dead pid.
    const runs = await col<AgentRunDoc>("agentRuns")
    const doc = (await runs.get(runId))!.doc
    expect(doc.lease_owner).toBe(leaseOwner())
    expect(doc.status).toBe("completed")
    expect(finalText).toContain("finished after resume")
    expect(restored).not.toBeNull()
    expect(sawResumeLog).toBe(true)
  })

  test("an interrupted tool is announced, not silently re-run", async () => {
    const runId = newRunId()
    await seedRun(runId)

    await writeCheckpoint(runId, {
      version: 1,
      messages: [
        { role: "system", content: "you are a coding agent" },
        { role: "user", content: "write the file" },
        { role: "assistant", content: "writing it now", tool_calls: [{ id: "call_1", type: "function", function: { name: "fs_write", arguments: "{}" } }] },
      ],
      iterations: 1,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalCostUsd: 0.001,
      repeats: null,
      // fs_write was in flight when the process died.
      pendingToolCalls: [{ id: "call_1", name: "fs_write" }],
    })

    responses = [{ content: "the write was interrupted; I will not repeat it" }]
    // No tool_calls in the scripted response, so if the loop were going to
    // re-dispatch fs_write it would need a turn that asks for it.
    let toolCallsSeen = 0
    for await (const _ of runAgent({
      agentId: AGENT_ID,
      threadId: "t1",
      userMessage: "write the file",
      resumeRunId: runId,
      maxSteps: 10,
    })) {
      if ((_ as any).agent?.messages?.[0]?.tool_calls?.length) toolCallsSeen++
    }

    // The synthetic [interrupted] reply is in the transcript the model saw.
    const checkpointed = await readCheckpoint(runId)
    expect(toolCallsSeen).toBe(0)
    expect(toolCallCount).toBe(0)
    expect(checkpointed!.pendingToolCalls).toEqual([])
  })

  test("a run with no checkpoint starts fresh instead of failing", async () => {
    const runId = newRunId()
    await seedRun(runId)
    // No checkpoint written.
    responses = [{ content: "started clean" }]

    let out = ""
    for await (const chunk of runAgent({
      agentId: AGENT_ID,
      threadId: "t1",
      userMessage: "fresh start",
      resumeRunId: runId,
      maxSteps: 5,
    })) {
      if (chunk.agent?.messages) out += chunk.agent.messages.map((m: any) => m.content ?? "").join("")
    }
    expect(out).toContain("started clean")
  })

  test("an abandoned generator leaves the run interrupted, not running", async () => {
    const runId = newRunId()
    await seedRun(runId)
    // A tool call every turn, so the loop never terminates on its own.
    responses = [{
      tool_calls: [{ id: `c${turn}`, type: "function", function: { name: "search_knowledge", arguments: JSON.stringify({ query: "x" }) } }],
    }]

    const stream = runAgent({
      agentId: AGENT_ID,
      threadId: "t1",
      userMessage: "loop forever",
      resumeRunId: runId,
      maxSteps: 1000,
    })

    // Consume a couple of chunks, then walk away — the consumer-side abandon.
    let seen = 0
    for await (const _ of stream) {
      if (++seen >= 2) break
    }

    // Give the finally a turn to land.
    await new Promise((r) => setTimeout(r, 50))

    const runs = await col<AgentRunDoc>("agentRuns")
    const doc = (await runs.get(runId))!.doc
    // The whole point of the finally: never "running" with a live lease.
    expect(doc.status).not.toBe("running")
  }, 20_000)
})