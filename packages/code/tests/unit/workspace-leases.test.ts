import { describe, expect, test } from "bun:test"
import { WorkspaceLeaseManager } from "../../src/workspace/leases"

describe("WorkspaceLeaseManager", () => {
  test("blocks overlapping writes to the same workspace path", () => {
    const leases = new WorkspaceLeaseManager(60_000, () => 100)

    const first = leases.acquire({
      taskId: "task-1",
      workspaceId: "base",
      path: "./src/app.ts",
      heldByWorker: "backend",
      operation: "edit",
    })
    const second = leases.acquire({
      taskId: "task-1",
      workspaceId: "base",
      path: "src/app.ts",
      heldByWorker: "frontend",
      operation: "write",
    })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.conflict.heldByWorker).toBe("backend")
    }
  })

  test("same worker refreshes its own lease and release frees the path", () => {
    let now = 100
    const leases = new WorkspaceLeaseManager(10, () => now)

    const first = leases.acquire({
      taskId: "task-1",
      workspaceId: "base",
      path: "src/app.ts",
      heldByWorker: "backend",
      operation: "edit",
    })
    now = 105
    const refreshed = leases.acquire({
      taskId: "task-1",
      workspaceId: "base",
      path: "src/app.ts",
      heldByWorker: "backend",
      operation: "write",
    })

    expect(first.ok).toBe(true)
    expect(refreshed.ok).toBe(true)
    if (refreshed.ok) {
      expect(refreshed.lease.operation).toBe("write")
      expect(leases.release(refreshed.lease.leaseId)).toBe(true)
    }
    expect(leases.list()).toHaveLength(0)
  })

  test("expired leases are pruned before acquire", () => {
    let now = 100
    const leases = new WorkspaceLeaseManager(10, () => now)

    leases.acquire({ taskId: "task-1", workspaceId: "base", path: "src/app.ts", heldByWorker: "backend", operation: "edit" })
    now = 111
    const next = leases.acquire({ taskId: "task-2", workspaceId: "base", path: "src/app.ts", heldByWorker: "frontend", operation: "edit" })

    expect(next.ok).toBe(true)
  })
})
