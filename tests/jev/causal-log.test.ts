/**
 * G9 causal log — write side, thread reconstruction, and whole-history stats.
 *
 * Exercises the real HiveDB event log, because the properties that matter here
 * (causation chaining, thread reconstruction, toolStats aggregation) only exist
 * in the store. A mock would test nothing.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { getHiveDb, closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { formatCausalEvent, causalLogEnabled } from "@johpaz/hivecode-core/storage/causal-events"

const STREAM = `test:causal:${Date.now()}`
const AGENT = "test-agent"
// The store validates the correlation as a UUID and requires payload.actor on
// IntentLogged — the G9 payload vocabulary is enforced, not documented only.
const CORRELATION = crypto.randomUUID()

let db: Awaited<ReturnType<typeof getHiveDb>>

beforeAll(async () => {
  db = await getHiveDb()
})

afterAll(() => {
  closeHiveDb()
})

async function append(input: {
  kind: string
  payload: Record<string, unknown>
  causation?: number
}) {
  return await db.append({
    agentId: AGENT,
    streamId: STREAM,
    kind: input.kind as never,
    payload: JSON.stringify(input.payload),
    causation: input.causation,
    correlation: CORRELATION,
  })
}

describe("causalLogEnabled", () => {
  test("defaults to off", () => {
    delete process.env.HIVE_CAUSAL_LOG
    expect(causalLogEnabled()).toBe(false)
  })

  test("accepts the documented on-values", () => {
    process.env.HIVE_CAUSAL_LOG = "1"
    expect(causalLogEnabled()).toBe(true)
    process.env.HIVE_CAUSAL_LOG = "true"
    expect(causalLogEnabled()).toBe(true)
    process.env.HIVE_CAUSAL_LOG = "false"
    expect(causalLogEnabled()).toBe(false)
    delete process.env.HIVE_CAUSAL_LOG
  })
})

describe("G9 event log", () => {
  test("an intent opens a chain that causation walks in order", async () => {
    const intent = await append({
      kind: "IntentLogged",
      payload: { actor: AGENT, intent: "refactor the parser" },
    })
    expect(typeof intent).toBe("number")

    const decision = await append({
      kind: "StateTransition",
      payload: { description: "read the file first" },
      causation: intent,
    })
    expect(decision).toBeGreaterThan(intent)

    const call = await append({
      kind: "ToolCall",
      payload: { tool: "fs_read", latency_ms: 12, outcome: "Ok" },
      causation: decision,
    })
    expect(call).toBeGreaterThan(decision)

    const thread = await db.causalThread(STREAM) as {
      decisions: Array<{ seq: number; description: string }>
      toolCalls: Array<{ tool: string }>
    }

    expect(thread.decisions.length).toBeGreaterThan(0)
    expect(thread.decisions.some(d => d.description.includes("read the file"))).toBe(true)
    expect(thread.toolCalls.some(t => t.tool === "fs_read")).toBe(true)
  })

  test("toolStats aggregates over the whole log, not one batch", async () => {
    const stats = await db.toolStats("fs_read") as
      { invocations: number; errors: number; totalLatencyMs: number } | null
    expect(stats).not.toBeNull()
    expect(stats!.invocations).toBeGreaterThanOrEqual(1)
    expect(stats!.totalLatencyMs).toBeGreaterThanOrEqual(12)
  })

  test("a tool with no events has no stats rather than zeroed stats", async () => {
    const stats = await db.toolStats("__never_called__")
    // The store returns undefined, not a zeroed aggregate: "no data" and
    // "zero failures" must not look the same to the reflector.
    expect(stats ?? null).toBeNull()
  })

  test("a failed call is recorded as an error outcome", async () => {
    const base = await append({ kind: "IntentLogged", payload: { actor: AGENT, intent: "fail" } })
    await append({
      kind: "ToolCall",
      payload: { tool: "shell_executor", latency_ms: 5, outcome: { Err: "boom" } },
      causation: base,
    })

    const stats = await db.toolStats("shell_executor") as { errors: number } | null
    expect(stats?.errors ?? 0).toBeGreaterThanOrEqual(1)
  })

  test("buildAgentContext projects the chain without needing embeddings", async () => {
    const ctx = await db.buildAgentContext({
      taskId: STREAM,
      currentPhase: "current",
      currentObjective: "refactor the parser",
      maxTokens: 2000,
      strategy: { causalAnchors: true, compressCompletedPhases: true },
    }) as { items: Array<{ type: string; text?: string }>; anomalies: unknown[] }

    expect(Array.isArray(ctx.items)).toBe(true)
    // The chain exists, so at least one anchor should come back.
    expect(ctx.items.length).toBeGreaterThan(0)
  })
})

describe("formatCausalEvent", () => {
  const ev = (kindTag: string, payload: Record<string, unknown>) => ({
    seq: 7,
    agentId: AGENT,
    streamId: `${STREAM}0123456789abcdef`,
    kindTag,
    payload: JSON.stringify(payload),
  }) as never

  test("an intent renders its text", () => {
    const line = formatCausalEvent(ev("IntentLogged", { intent: "do the thing" }))
    expect(line).toContain("IntentLogged")
    expect(line).toContain("do the thing")
  })

  test("a tool call renders tool, latency and outcome", () => {
    const ok = formatCausalEvent(ev("ToolCall", { tool: "fs_read", latency_ms: 42, outcome: "Ok" }))
    expect(ok).toContain("fs_read")
    expect(ok).toContain("42ms")
    expect(ok).toContain("ok")

    const err = formatCausalEvent(ev("ToolCall", { tool: "fs_write", latency_ms: 9, outcome: { Err: "denied" } }))
    expect(err).toContain("ERR: denied")

    const timeout = formatCausalEvent(ev("ToolCall", { tool: "web_fetch", latency_ms: 3000, outcome: "Timeout" }))
    expect(timeout).toContain("TIMEOUT")
  })

  test("a malformed payload still renders the header", () => {
    const broken = { ...(ev("StateTransition", {}) as object), payload: "{not json" } as never
    const line = formatCausalEvent(broken)
    expect(line).toContain("StateTransition")
  })

  test("long text is truncated rather than dumped", () => {
    const line = formatCausalEvent(ev("IntentLogged", { intent: "x".repeat(500) }))
    expect(line).toContain("…")
    expect(line.length).toBeLessThan(300)
  })
})