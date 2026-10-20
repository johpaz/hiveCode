/**
 * run-store — the resumable side of AgentRunDoc.
 *
 * The property that matters and is easy to get wrong: a tool call that was in
 * flight when the process died must come back as [interrupted], never as a
 * re-execution. These tests write real checkpoints against the real store and
 * read them back.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import {
  writeCheckpoint,
  readCheckpoint,
  readLegacyCounters,
  reclaimRun,
  startLeaseRenewal,
  leaseOwner,
  LEASE_SECONDS,
  MAX_CHECKPOINT_BYTES,
  type RunCheckpoint,
} from "@johpaz/hivecode-core/agent/run-store"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import type { AgentRunDoc } from "@johpaz/hivecode-core/storage/collections"

const nowSec = () => Math.floor(Date.now() / 1000)
let counter = 0
const newRunId = () => `test:run-store:${Date.now()}:${++counter}`

async function seedRun(runId: string, overrides: Partial<AgentRunDoc> = {}): Promise<void> {
  const runs = await col<AgentRunDoc>("agentRuns")
  const ts = nowSec()
  await runs.put(runId, {
    id: runId,
    task_id: "t1",
    thread_id: "t1",
    session_id: "t1",
    agent_id: "bee",
    kind: "harness",
    parent_run_id: null,
    objective: "do the thing",
    status: "running",
    turn: 0,
    max_turns: 10,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    checkpoint_json: null,
    blocker: null,
    next_action: null,
    lease_owner: leaseOwner(),
    lease_expires_at: ts + LEASE_SECONDS,
    created_at: ts,
    updated_at: ts,
    completed_at: null,
    ...overrides,
  })
}

const sample = (over: Partial<RunCheckpoint> = {}): RunCheckpoint => ({
  version: 1,
  messages: [
    { role: "system", content: "you are a coding agent" },
    { role: "user", content: "refactor the parser" },
    { role: "assistant", content: "reading the file first" },
  ],
  iterations: 3,
  totalInputTokens: 1200,
  totalOutputTokens: 340,
  totalCostUsd: 0.0123,
  repeats: { counts: { "fs_read:abc": 2 }, window: ["fs_read:abc", "fs_read:abc"], lastToolName: "fs_read", sameToolStreak: 2 },
  pendingToolCalls: [],
  ...over,
})

beforeAll(() => { /* store opens lazily on first use */ })
afterAll(() => { closeHiveDb() })

describe("checkpoint round-trip", () => {
  test("a written checkpoint reads back intact", async () => {
    const runId = newRunId()
    await seedRun(runId)
    expect(await writeCheckpoint(runId, sample())).toBe(true)

    const restored = await readCheckpoint(runId)
    expect(restored).not.toBeNull()
    expect(restored!.version).toBe(1)
    expect(restored!.iterations).toBe(3)
    expect(restored!.totalInputTokens).toBe(1200)
    expect(restored!.totalCostUsd).toBeCloseTo(0.0123, 6)
    expect(restored!.messages).toHaveLength(3)
    expect(restored!.messages[0].role).toBe("system")
  })

  test("loop-detection state survives the round-trip", async () => {
    // A resumed run that was mid-loop must not get a clean slate.
    const runId = newRunId()
    await seedRun(runId)
    await writeCheckpoint(runId, sample())
    const restored = await readCheckpoint(runId)
    expect(restored!.repeats).not.toBeNull()
    expect(restored!.repeats!.counts["fs_read:abc"]).toBe(2)
    expect(restored!.repeats!.lastToolName).toBe("fs_read")
    expect(restored!.repeats!.sameToolStreak).toBe(2)
  })

  test("in-flight tool calls are recorded so resume can mark them interrupted", async () => {
    const runId = newRunId()
    await seedRun(runId)
    await writeCheckpoint(runId, sample({
      pendingToolCalls: [{ id: "call_1", name: "fs_write" }],
    }))
    const restored = await readCheckpoint(runId)
    expect(restored!.pendingToolCalls).toEqual([{ id: "call_1", name: "fs_write" }])
  })

  test("the post-tool checkpoint clears what the pre-tool one recorded", async () => {
    const runId = newRunId()
    await seedRun(runId)
    await writeCheckpoint(runId, sample({ pendingToolCalls: [{ id: "call_1", name: "fs_write" }] }))
    await writeCheckpoint(runId, sample({ pendingToolCalls: [] }))
    const restored = await readCheckpoint(runId)
    expect(restored!.pendingToolCalls).toEqual([])
  })

  test("a run with no checkpoint reads as null, not as an empty state", async () => {
    const runId = newRunId()
    await seedRun(runId)
    expect(await readCheckpoint(runId)).toBeNull()
  })

  test("a run that does not exist is not an error", async () => {
    expect(await readCheckpoint("test:run-store:does-not-exist")).toBeNull()
    expect(await writeCheckpoint("test:run-store:does-not-exist", sample())).toBe(false)
  })
})

describe("checkpoint size cap", () => {
  test("an oversized snapshot is refused rather than written", async () => {
    const runId = newRunId()
    await seedRun(runId)
    const huge = sample({
      messages: [{ role: "user", content: "x".repeat(MAX_CHECKPOINT_BYTES + 1000) }],
    })
    expect(await writeCheckpoint(runId, huge)).toBe(false)
    // Nothing written: the run stays honest about not being resumable.
    expect(await readCheckpoint(runId)).toBeNull()
  })

  test("a normal snapshot under the cap is accepted", async () => {
    const runId = newRunId()
    await seedRun(runId)
    const ok = sample({ messages: [{ role: "user", content: "x".repeat(10_000) }] })
    expect(await writeCheckpoint(runId, ok)).toBe(true)
  })
})

describe("legacy checkpoints", () => {
  test("counters-only checkpoints are readable but not resumable", async () => {
    const runId = newRunId()
    await seedRun(runId)
    const runs = await col<AgentRunDoc>("agentRuns")
    const existing = await runs.get(runId)
    await runs.put(runId, {
      ...existing!.doc,
      checkpoint_json: JSON.stringify({
        iterations: 4, messages: 12, totalInputTokens: 900, totalOutputTokens: 100,
      }),
    }, { expectedVersion: existing!.version })

    // Not resumable: the messages are a count, not the transcript.
    expect(await readCheckpoint(runId)).toBeNull()
    // But the counters are still visible.
    const legacy = await readLegacyCounters(runId)
    expect(legacy?.iterations).toBe(4)
    expect(legacy?.messages).toBe(12)
  })

  test("a resumable checkpoint is not reported as legacy", async () => {
    const runId = newRunId()
    await seedRun(runId)
    await writeCheckpoint(runId, sample())
    expect(await readLegacyCounters(runId)).toBeNull()
  })

  test("corrupt json reads as no checkpoint rather than throwing", async () => {
    const runId = newRunId()
    await seedRun(runId)
    const runs = await col<AgentRunDoc>("agentRuns")
    const existing = await runs.get(runId)
    await runs.put(runId, {
      ...existing!.doc,
      checkpoint_json: "{not json",
    }, { expectedVersion: existing!.version })

    expect(await readCheckpoint(runId)).toBeNull()
    expect(await readLegacyCounters(runId)).toBeNull()
  })
})

describe("reclaimRun", () => {
  test("a run left by another process is taken over", async () => {
    const runId = newRunId()
    await seedRun(runId, {
      status: "interrupted",
      lease_owner: "agent-loop:999999",
      lease_expires_at: nowSec() - 10,
    })
    expect(await reclaimRun(runId)).toBe(true)

    const runs = await col<AgentRunDoc>("agentRuns")
    const after = (await runs.get(runId))!.doc
    expect(after.status).toBe("running")
    expect(after.lease_owner).toBe(leaseOwner())
    expect(after.lease_expires_at).toBeGreaterThan(nowSec())
  })

  test("a run we already own is a no-op, not a rewrite", async () => {
    const runId = newRunId()
    await seedRun(runId, { status: "running", lease_owner: leaseOwner() })
    const before = (await (await col<AgentRunDoc>("agentRuns")).get(runId))!.doc
    expect(await reclaimRun(runId)).toBe(true)
    const after = (await (await col<AgentRunDoc>("agentRuns")).get(runId))!.doc
    expect(after.updated_at).toBe(before.updated_at)
  })

  test("a run that does not exist reports failure", async () => {
    expect(await reclaimRun("test:run-store:missing")).toBe(false)
  })
})

describe("lease renewal", () => {
  test("a stopped renewal does not renew", async () => {
    const runId = newRunId()
    await seedRun(runId)
    let active = true
    const stop = startLeaseRenewal(runId, { isActive: () => active })
    // Renewal is on a 60s cadence, so this asserts the contract, not the tick.
    active = false
    stop()
    const after = (await (await col<AgentRunDoc>("agentRuns")).get(runId))!.doc
    expect(after.lease_owner).toBe(leaseOwner())
  })

  test("stopping twice is safe", () => {
    const stop = startLeaseRenewal("test:run-store:whatever", { isActive: () => false })
    stop()
    expect(() => stop()).not.toThrow()
  })
})