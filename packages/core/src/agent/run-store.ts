/**
 * Run store — the resumable side of AgentRunDoc.
 *
 * An agent run that cannot be resumed is telemetry; one that can is a process.
 * This module owns everything about that: writing a full state snapshot,
 * recording which tool calls were in flight when the snapshot was taken,
 * taking ownership of a run abandoned by a dead process, and keeping the lease
 * alive while this process is actually working.
 *
 * Everything here is fail-soft. A checkpoint that cannot be written must not
 * take down the turn that produced it — losing durability is strictly better
 * than losing the run.
 *
 * The payload lives inside the existing `checkpoint_json` column rather than in
 * new columns: it is opaque to every reader, and `hive` and `hivecode` are
 * separate lineages with no data to interop with (see the plan's §5.4).
 */
import { col } from "../storage/hive"
import type { AgentRunDoc } from "../storage/collections"
import { logger } from "../utils/logger"
import type { LLMMessage } from "./llm-client"

const log = logger.child("run-store")

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** Lease duration and renewal cadence, in seconds. */
export const LEASE_SECONDS = 3600
export const LEASE_RENEW_INTERVAL_MS = 60_000

/**
 * Ceiling on a serialized checkpoint. A conversation can grow past what is sane
 * to rewrite on every tool-bearing iteration; past this the run keeps counting
 * as telemetry and stops claiming to be resumable, rather than spending the
 * turn's budget on its own checkpoint.
 */
export const MAX_CHECKPOINT_BYTES = 512 * 1024

/** Loop-detection state carried across a resume; see RepeatTracker.snapshot(). */
export interface RepeatTrackerSnapshot {
  counts: Record<string, number>
  window: string[]
  lastToolName: string
  sameToolStreak: number
}

export interface RunCheckpoint {
  version: 1
  messages: LLMMessage[]
  iterations: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  /** Loop-detection state, so a resumed run does not restart its streak at zero. */
  repeats: RepeatTrackerSnapshot | null
  /**
   * Tool calls that were dispatched when this snapshot was taken. On resume
   * each becomes a synthetic [interrupted] message instead of a re-execution:
   * a tool that already half-ran must not be run again on its account.
   */
  pendingToolCalls: Array<{ id: string; name: string }>
}

/** The counters-only shape written by older builds. Still readable, not resumable. */
interface LegacyCheckpoint {
  iterations: number
  messages: number
  totalInputTokens: number
  totalOutputTokens: number
}

function isResumable(value: unknown): value is RunCheckpoint {
  return !!value
    && typeof value === "object"
    && (value as RunCheckpoint).version === 1
    && Array.isArray((value as RunCheckpoint).messages)
}

function runsCol() {
  return col<AgentRunDoc>("agentRuns")
}

/**
 * Persist a full snapshot. Returns false when the run could not be written or
 * the snapshot was too large — the caller treats that as "this run is
 * telemetry, not resumable" and keeps going.
 */
export async function writeCheckpoint(runId: string, state: RunCheckpoint): Promise<boolean> {
  let serialized: string
  try {
    serialized = JSON.stringify(state)
  } catch (err) {
    log.warn(`[run-store] checkpoint not serializable for ${runId}: ${(err as Error).message}`)
    return false
  }

  if (serialized.length > MAX_CHECKPOINT_BYTES) {
    log.info(
      `[run-store] checkpoint for ${runId} is ${Math.round(serialized.length / 1024)}KB ` +
      `(cap ${Math.round(MAX_CHECKPOINT_BYTES / 1024)}KB) — run stays resumable=no`,
    )
    return false
  }

  try {
    const runs = await runsCol()
    const existing = await runs.get(runId)
    if (!existing) return false
    await runs.put(runId, {
      ...existing.doc,
      checkpoint_json: serialized,
      updated_at: nowSec(),
    }, { expectedVersion: existing.version })
    return true
  } catch (err) {
    log.warn(`[run-store] failed to write checkpoint for ${runId}: ${(err as Error).message}`)
    return false
  }
}

/** The resumable snapshot for a run, or null when there is none to resume from. */
export async function readCheckpoint(runId: string): Promise<RunCheckpoint | null> {
  try {
    const runs = await runsCol()
    const entry = await runs.get(runId)
    const raw = entry?.doc.checkpoint_json
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isResumable(parsed) ? parsed : null
  } catch (err) {
    log.warn(`[run-store] failed to read checkpoint for ${runId}: ${(err as Error).message}`)
    return null
  }
}

/** Read the counters a legacy (non-resumable) checkpoint left, for observability. */
export async function readLegacyCounters(runId: string): Promise<LegacyCheckpoint | null> {
  try {
    const runs = await runsCol()
    const entry = await runs.get(runId)
    const raw = entry?.doc.checkpoint_json
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isResumable(parsed) ? null : (parsed as LegacyCheckpoint)
  } catch {
    return null
  }
}

/**
 * Take ownership of a run left behind by a dead process.
 *
 * Reconciliation and the adaptive scheduler both expire leases, but they only
 * do it lazily — a run can still read "running" here with a boot id from a
 * process that no longer exists. Claiming it is what lets the lease renewer
 * start; without this the run stays invisible until something else notices.
 */
export async function reclaimRun(runId: string): Promise<boolean> {
  try {
    const runs = await runsCol()
    const existing = await runs.get(runId)
    if (!existing) return false
    if (existing.doc.status === "running" && existing.doc.lease_owner === leaseOwner()) {
      return true // already ours
    }
    await runs.put(runId, {
      ...existing.doc,
      status: "running",
      lease_owner: leaseOwner(),
      lease_expires_at: nowSec() + LEASE_SECONDS,
      updated_at: nowSec(),
    }, { expectedVersion: existing.version })
    log.info(`[run-store] reclaimed run ${runId} from ${existing.doc.lease_owner || "(none)"}`)
    return true
  } catch (err) {
    log.warn(`[run-store] failed to reclaim run ${runId}: ${(err as Error).message}`)
    return false
  }
}

export function leaseOwner(): string {
  return `agent-loop:${process.pid}`
}

/**
 * Keep the lease fresh until the returned function is called.
 *
 * Without this a run longer than the lease window looks abandoned to
 * adaptive-scheduler, which reads `lease_expires_at <= now || !ownerProcessAlive`
 * and reclaims it out from under a live process.
 */
export function startLeaseRenewal(runId: string, opts: { isActive: () => boolean }): () => void {
  const timer = setInterval(() => {
    if (!opts.isActive()) return
    void (async () => {
      try {
        const runs = await runsCol()
        const existing = await runs.get(runId)
        if (!existing) return
        // Never resurrect a finished run: if something else already closed it
        // out, the lease has nothing left to protect.
        if (existing.doc.status !== "running") return
        await runs.put(runId, {
          ...existing.doc,
          lease_expires_at: nowSec() + LEASE_SECONDS,
          updated_at: nowSec(),
        }, { expectedVersion: existing.version })
      } catch (err) {
        log.debug(`[run-store] lease renewal failed for ${runId}: ${(err as Error).message}`)
      }
    })()
  }, LEASE_RENEW_INTERVAL_MS)

  // Never hold the process open for a lease.
  if (typeof timer === "object" && "unref" in timer) timer.unref()

  return () => clearInterval(timer)
}