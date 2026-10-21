import { afterEach, describe, expect, test } from "bun:test"
import { announceDelegation, awaitDelegation, delegationOutcome, resetDelegationBoard, settleDelegation } from "./delegation-board"
import { ensureInstance, instanceId, parseInstanceId } from "./swarm-instances"
import { filesInPatch, registerSwarmRuntime } from "./swarm-runtime"
import { structuralParallelism } from "./swarm-capabilities"
import { col } from "../storage/hive"
import type { AgentDoc } from "../storage/collections"

afterEach(() => { resetDelegationBoard(); registerSwarmRuntime(null) })

describe("delegation board", () => {
  test("a waiter is released when the task it waits for settles", async () => {
    announceDelegation("T001")
    const waiting = awaitDelegation("T001", { timeoutMs: 2000 })
    settleDelegation({ ref: "T001", status: "completed", result: "api listo" }, "T001", "42")
    const settled = await waiting
    expect(settled.ok && settled.entry.result).toBe("api listo")
    expect(delegationOutcome("t001")?.status).toBe("completed") // refs are case-insensitive
    expect(delegationOutcome("42")?.status).toBe("completed") // and so is the task id
  })

  test("a ref announced a moment later (same batch) is still found", async () => {
    const waiting = awaitDelegation("T002", { graceMs: 1000, timeoutMs: 2000 })
    setTimeout(() => settleDelegation({ status: "completed", result: "ok" }, "T002"), 30)
    expect((await waiting).ok).toBe(true)
  })

  test("a ref nobody announces is reported unknown, not waited for forever", async () => {
    const result = await awaitDelegation("T404", { graceMs: 40 })
    expect(result).toEqual({ ok: false, reason: "unknown" })
  })

  test("an announced task that never settles times out; abort wakes the waiter", async () => {
    announceDelegation("T003")
    expect(await awaitDelegation("T003", { timeoutMs: 40 })).toEqual({ ok: false, reason: "timeout" })
    const controller = new AbortController()
    const waiting = awaitDelegation("T003", { signal: controller.signal, timeoutMs: 5000 })
    controller.abort()
    expect(await waiting).toEqual({ ok: false, reason: "aborted" })
  })

  test("re-delegating a ref starts over instead of reusing the old outcome", () => {
    settleDelegation({ status: "failed", result: "x" }, "T005")
    announceDelegation("T005")
    expect(delegationOutcome("T005")).toBeUndefined()
  })
})

describe("instances", () => {
  test("ids round-trip", () => {
    expect(parseInstanceId("builder#2")).toEqual({ base: "builder", n: 2 })
    expect(parseInstanceId("builder")).toEqual({ base: "builder", n: 1 })
    expect(instanceId("builder", 1)).toBe("builder")
    expect(instanceId("builder", 3)).toBe("builder#3")
  })

  test("builder#2 is cloned from builder; out-of-range or unknown bases are refused", async () => {
    const agents = await col<AgentDoc>("agents")
    const base = (await agents.get("builder"))?.doc
    if (!base) return // profiles are seeded by the harness; nothing to clone in a bare DB
    const clone = await ensureInstance("builder#2")
    expect(clone?.id).toBe("builder#2")
    expect(clone?.ephemeral).toBe(true)
    expect(clone?.tools_json).toBe(base.tools_json)
    expect(await ensureInstance("builder#9")).toBeNull()
    expect(await ensureInstance("nope#2")).toBeNull()
    await agents.delete("builder#2")
  })
})

describe("structuralParallelism with instances", () => {
  const call = (worker_id: string) => ({ function: { name: "task_delegate", arguments: JSON.stringify({ worker_id }) } })
  const put = async (id: string, extra: Partial<AgentDoc> = {}) => {
    const agents = await col<AgentDoc>("agents")
    await agents.put(id, { id, name: id, role: "worker", enabled: true, permission_profile: "write_workspace", workspace: "/tmp/same", status: "idle", ...extra } as AgentDoc, { expectedVersion: 0 }).catch(() => {})
  }

  test("two writers on the same workspace are sequential; with a swarm runtime the instance is parallel", async () => {
    await put("zz_builder")
    expect((await structuralParallelism([call("zz_builder"), call("zz_builder#2")]))?.safe).toBe(false)
    registerSwarmRuntime({ prepare: async () => "/tmp/x", integrate: async () => ({ status: "noop", files: [] }), cleanup: async () => {} })
    expect((await structuralParallelism([call("zz_builder"), call("zz_builder#2")]))?.safe).toBe(true)
    expect((await structuralParallelism([call("zz_builder#2"), call("zz_builder#3")]))?.safe).toBe(true)
    expect((await structuralParallelism([call("zz_builder#2"), call("zz_builder#2")]))?.safe).toBe(false) // same instance twice
    const agents = await col<AgentDoc>("agents")
    await agents.delete("zz_builder")
  })
})

test("filesInPatch lists the files a diff touches", () => {
  expect(filesInPatch("diff --git a/a.ts b/a.ts\n--- a\n+++ b\ndiff --git a/dir/b.ts b/dir/b.ts\n")).toEqual(["a.ts", "dir/b.ts"])
})

describe("a worker's own parallel tool calls", () => {
  const w = (name: string, p: string) => ({ function: { name, arguments: JSON.stringify({ path: p }) } })
  test("writes to different files run together; the same file, a read of a written file, or a shell do not", async () => {
    expect(await structuralParallelism([w("fs_write", "a.ts"), w("fs_write", "b.ts"), w("fs_edit", "c.ts")])).toEqual({ kind: "writes", safe: true })
    expect((await structuralParallelism([w("fs_write", "a.ts"), w("fs_read", "other.ts")]))?.safe).toBe(true)
    expect((await structuralParallelism([w("fs_write", "a.ts"), w("fs_edit", "./a.ts")]))?.safe).toBe(false)
    expect((await structuralParallelism([w("fs_write", "a.ts"), w("fs_read", "a.ts")]))?.safe).toBe(false)
    expect((await structuralParallelism([w("fs_write", "a.ts"), w("fs_list", ".")]))?.safe).toBe(false)
    expect(await structuralParallelism([w("fs_write", "a.ts"), { function: { name: "shell_executor", arguments: "{}" } }])).toBeUndefined()
  })
})
