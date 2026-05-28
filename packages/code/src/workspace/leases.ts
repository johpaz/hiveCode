export type WorkspaceLeaseOperation = "write" | "edit" | "delete"

export interface WorkspaceLease {
  leaseId: string
  taskId: string
  workspaceId: string
  path: string
  heldByWorker: string
  operation: WorkspaceLeaseOperation
  expiresAt: number
}

export interface LeaseAcquireInput {
  taskId: string
  workspaceId: string
  path: string
  heldByWorker: string
  operation: WorkspaceLeaseOperation
  ttlMs?: number
}

export type LeaseAcquireResult =
  | { ok: true; lease: WorkspaceLease }
  | { ok: false; conflict: WorkspaceLease }

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "")
}

function defaultLeaseId(): string {
  return typeof Bun !== "undefined" && typeof Bun.randomUUIDv7 === "function"
    ? Bun.randomUUIDv7()
    : crypto.randomUUID()
}

export class WorkspaceLeaseManager {
  private leases = new Map<string, WorkspaceLease>()

  constructor(
    private defaultTtlMs = 60_000,
    private now: () => number = () => Date.now(),
  ) {}

  acquire(input: LeaseAcquireInput): LeaseAcquireResult {
    this.pruneExpired()
    const path = normalizePath(input.path)
    const key = this.key(input.workspaceId, path)
    const existing = this.leases.get(key)

    if (existing) {
      if (existing.taskId === input.taskId && existing.heldByWorker === input.heldByWorker) {
        const refreshed = {
          ...existing,
          operation: input.operation,
          expiresAt: this.now() + (input.ttlMs ?? this.defaultTtlMs),
        }
        this.leases.set(key, refreshed)
        return { ok: true, lease: { ...refreshed } }
      }
      return { ok: false, conflict: { ...existing } }
    }

    const lease: WorkspaceLease = {
      leaseId: defaultLeaseId(),
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      path,
      heldByWorker: input.heldByWorker,
      operation: input.operation,
      expiresAt: this.now() + (input.ttlMs ?? this.defaultTtlMs),
    }
    this.leases.set(key, lease)
    return { ok: true, lease: { ...lease } }
  }

  release(leaseId: string): boolean {
    for (const [key, lease] of this.leases) {
      if (lease.leaseId === leaseId) {
        this.leases.delete(key)
        return true
      }
    }
    return false
  }

  releaseByOwner(taskId: string, heldByWorker?: string): number {
    let released = 0
    for (const [key, lease] of this.leases) {
      if (lease.taskId === taskId && (!heldByWorker || lease.heldByWorker === heldByWorker)) {
        this.leases.delete(key)
        released += 1
      }
    }
    return released
  }

  list(): WorkspaceLease[] {
    this.pruneExpired()
    return [...this.leases.values()].map((lease) => ({ ...lease }))
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(key)
    }
  }

  private key(workspaceId: string, path: string): string {
    return `${workspaceId}:${normalizePath(path)}`
  }
}
