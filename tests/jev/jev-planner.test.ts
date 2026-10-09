/**
 * Jev planner — guards, thresholds and fail-open behavior.
 *
 * Every entry point must return null (keep the unpruned plan) rather than throw
 * or half-prune when the decision plane is unavailable. That contract is what
 * makes it safe to have on the critical path, so it is what these tests pin.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"

const HIVE_AGENT = "bee"

// Jev is reached through askJev, which needs a provider key. Stub the module so
// the planner's own logic is under test, not the transport.
let jevEnabled = false
let answerPayload: Record<string, any> | null = null
let askCalls: Array<{ state: unknown; questions: Record<string, any> }> = []

mock.module("@johpaz/hivecode-core/agent/jev-decisions", () => ({
  hasOracle: async () => jevEnabled,
  getJevKey: async () => (jevEnabled ? "sk-test" : null),
  JEV_MODEL: "typesafe/jev-1.13",
  askJev: async (state: unknown, questions: Record<string, any>) => {
    askCalls.push({ state, questions })
    if (!answerPayload) return null
    return { answers: answerPayload, inputTokens: 10, costUsd: 0.001, latencyMs: 42 }
  },
  emitJevDecision: () => {},
  getJevStatus: async () => ({ state: "ready", lastError: null, lastSuccessAt: null, totals: { decisions: 0, savedTokens: 0, costUsd: 0 } }),
  resetJevStatus: () => {},
}))

const { jevWantsParallel, planJevIteration, planJevContext } = await import(
  "@johpaz/hivecode-core/agent/jev-planner"
)
const { closeHiveDb } = await import("@johpaz/hivecode-core/storage/hivedb")

beforeEach(() => {
  jevEnabled = false
  answerPayload = null
  askCalls = []
})

afterEach(() => {
  closeHiveDb()
})

// ─── jevWantsParallel ───────────────────────────────────────────────────────

describe("jevWantsParallel", () => {
  const call = (name: string, args: unknown = {}) => ({ function: { name, arguments: args } })

  test("a single call is never a batch decision", async () => {
    expect(await jevWantsParallel([call("fs_read")])).toBeNull()
  })

  test("off: returns null and never asks", async () => {
    jevEnabled = false
    expect(await jevWantsParallel([call("fs_read"), call("fs_list")])).toBeNull()
    expect(askCalls).toHaveLength(0)
  })

  test("a writing tool is sequential without spending a decision", async () => {
    jevEnabled = true
    const result = await jevWantsParallel([call("fs_read"), call("fs_write")])
    expect(result).toEqual({ parallel: false })
    // Structurally known — asking would pay latency to learn nothing.
    expect(askCalls).toHaveLength(0)
  })

  test("read-only tools ask, and 0.8 is the bar for parallel", async () => {
    jevEnabled = true
    answerPayload = { independent: { type: "noul", noul: 0.9 } }
    const result = await jevWantsParallel([call("fs_read"), call("fs_glob")])
    expect(result?.parallel).toBe(true)
    expect(result?.decision?.latencyMs).toBe(42)
  })

  test("a hesitant answer stays sequential", async () => {
    jevEnabled = true
    answerPayload = { independent: { type: "noul", noul: 0.79 } }
    expect((await jevWantsParallel([call("fs_read"), call("fs_list")]))?.parallel).toBe(false)
  })

  test("delegations to the same worker are never parallel", async () => {
    jevEnabled = true
    const result = await jevWantsParallel([
      call("task_delegate", { worker_id: "scout" }),
      call("task_delegate", { worker_id: "scout" }),
    ])
    expect(result).toEqual({ parallel: false })
    expect(askCalls).toHaveLength(0)
  })

  test("delegations without a worker id are never parallel", async () => {
    jevEnabled = true
    expect(await jevWantsParallel([
      call("task_delegate", {}),
      call("task_delegate", { worker_id: "builder" }),
    ])).toEqual({ parallel: false })
  })

  test("a decision of null leaves the batch to the runtime default", async () => {
    jevEnabled = true
    answerPayload = null
    expect(await jevWantsParallel([call("fs_read"), call("web_search")])).toBeNull()
  })
})

// ─── planJevIteration ───────────────────────────────────────────────────────

describe("planJevIteration", () => {
  const toolMsg = (content: string, name = "fs_read") => ({ role: "tool" as const, content, name })
  const big = (n: number) => "x".repeat(n)

  test("no tool results means nothing to prune", async () => {
    jevEnabled = true
    const result = await planJevIteration({
      objective: "go",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
    })
    expect(result).toBeNull()
  })

  test("under the prune threshold it does not ask — a decision would cost more than it saves", async () => {
    jevEnabled = true
    const result = await planJevIteration({
      objective: "go",
      messages: [
        { role: "user", content: "go" },
        toolMsg(big(500)), toolMsg(big(500)), toolMsg(big(500)),
      ],
      tools: [],
    })
    expect(result).toBeNull()
    expect(askCalls).toHaveLength(0)
  })

  test("finish is refused when the last result failed", async () => {
    jevEnabled = true
    answerPayload = {
      action: { type: "choice", choice: "finish", confidence: 0.99, probabilities: {} },
      result_0: { type: "noul", noul: 0.0 },
    }
    const result = await planJevIteration({
      objective: "go",
      messages: [
        { role: "user", content: "go" },
        toolMsg(big(5000)), toolMsg(big(5000)), toolMsg("[Tool Error] it broke"),
      ],
      tools: [{ type: "function", function: { name: "fs_read", description: "", parameters: {} } }],
    })
    // Reporting a failure as success is the one outcome worth overriding Jev on.
    expect(result?.action).toBe("continue")
  })

  test("finish is honored when the last result succeeded", async () => {
    jevEnabled = true
    answerPayload = {
      action: { type: "choice", choice: "finish", confidence: 0.99, probabilities: {} },
      result_0: { type: "noul", noul: 0.0 },
    }
    const result = await planJevIteration({
      objective: "go",
      messages: [
        { role: "user", content: "go" },
        toolMsg(big(5000)), toolMsg(big(5000)), toolMsg("ok"),
      ],
      tools: [{ type: "function", function: { name: "fs_read", description: "", parameters: {} } }],
    })
    expect(result?.action).toBe("finish")
    expect(result?.tools).toEqual([])
  })

  test("finish below 0.85 confidence degrades to continue", async () => {
    jevEnabled = true
    answerPayload = {
      action: { type: "choice", choice: "finish", confidence: 0.8, probabilities: {} },
      result_0: { type: "noul", noul: 0.0 },
    }
    const result = await planJevIteration({
      objective: "go",
      messages: [
        { role: "user", content: "go" },
        toolMsg(big(5000)), toolMsg(big(5000)), toolMsg("ok"),
      ],
      tools: [{ type: "function", function: { name: "fs_read", description: "", parameters: {} } }],
    })
    expect(result?.action).toBe("continue")
  })

  test("delegate narrows the loadout to delegation tools", async () => {
    jevEnabled = true
    answerPayload = {
      action: { type: "choice", choice: "delegate", confidence: 0.95, probabilities: {} },
    }
    const result = await planJevIteration({
      objective: "go",
      messages: [
        { role: "user", content: "go" },
        toolMsg(big(5000)), toolMsg(big(5000)), toolMsg("ok"),
      ],
      tools: [
        { type: "function", function: { name: "fs_read", description: "", parameters: {} } },
        { type: "function", function: { name: "task_delegate", description: "", parameters: {} } },
        { type: "function", function: { name: "agent_find", description: "", parameters: {} } },
      ],
    })
    expect(result?.tools.map(t => t.function.name).sort()).toEqual(["agent_find", "task_delegate"])
  })

  test("a non-finish action never returns an empty loadout", async () => {
    jevEnabled = true
    answerPayload = {
      action: { type: "choice", choice: "delegate", confidence: 0.95, probabilities: {} },
    }
    const result = await planJevIteration({
      objective: "go",
      messages: [
        { role: "user", content: "go" },
        toolMsg(big(5000)), toolMsg(big(5000)), toolMsg("ok"),
      ],
      tools: [{ type: "function", function: { name: "fs_read", description: "", parameters: {} } }],
    })
    expect(result?.action).toBe("continue")
    expect(result?.tools).toHaveLength(1)
  })

  test("unavailable Jev keeps the messages untouched", async () => {
    jevEnabled = true
    answerPayload = null
    const messages = [
      { role: "user" as const, content: "go" },
      toolMsg(big(5000)), toolMsg(big(5000)), toolMsg("ok"),
    ]
    expect(await planJevIteration({ objective: "go", messages, tools: [] })).toBeNull()
  })
})

// ─── planJevContext ─────────────────────────────────────────────────────────

describe("planJevContext", () => {
  const base = {
    objective: "refactor the parser",
    tools: [] as any[],
    allTools: [] as any[],
    skills: [] as any[],
    isWorker: false,
  }

  test("off: returns null and never asks", async () => {
    jevEnabled = false
    const result = await planJevContext({
      ...base,
      messages: [{ role: "user", content: "hola" }, { role: "assistant", content: "hola" }],
    })
    expect(result).toBeNull()
    expect(askCalls).toHaveLength(0)
  })

  test("the trailing exchange is mandatory even when Jev rejects it", async () => {
    jevEnabled = true
    answerPayload = {
      history_0: { type: "noul", noul: 0 },
    }
    const messages = [
      { role: "user" as const, content: "viejo" },
      { role: "assistant" as const, content: "nuevo" },
    ]
    const result = await planJevContext({ ...base, messages })
    // Item 0 is inside the mandatory tail, so Jev is never asked about it and it survives.
    expect(result?.messages.map(m => m.content)).toEqual(["viejo", "nuevo"])
    expect(askCalls[0].questions.history_0).toBeUndefined()
  })

  test("an assistant turn keeps the user turn it answered", async () => {
    jevEnabled = true
    // Drop item 0 (its user turn), keep item 1 (assistant) — the pairing rule
    // must pull the user turn back or some providers drop the model turn.
    answerPayload = { history_1: { type: "noul", noul: 0.5 } }
    const messages = [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
      { role: "user" as const, content: "c" },
      { role: "assistant" as const, content: "d" },
      { role: "user" as const, content: "e" },
    ]
    const result = await planJevContext({ ...base, messages })
    expect(result?.messages.some(m => m.content === "b")).toBe(true)
  })

  test("minimal tools are never candidates for removal", async () => {
    jevEnabled = true
    const minimal = { type: "function" as const, function: { name: "search_knowledge", description: "d", parameters: {} } }
    answerPayload = { tool_search_knowledge: { type: "noul", noul: 0 } }
    const result = await planJevContext({
      ...base,
      tools: [minimal],
      allTools: [{ name: "search_knowledge", description: "d", parameters: {} }],
      messages: [{ role: "user", content: "x" }],
    })
    expect(result?.tools.map(t => t.function.name)).toContain("search_knowledge")
  })

  test("unavailable Jev returns null rather than a partial prune", async () => {
    jevEnabled = true
    answerPayload = null
    expect(await planJevContext({
      ...base,
      messages: [{ role: "user", content: "x" }],
    })).toBeNull()
  })
})