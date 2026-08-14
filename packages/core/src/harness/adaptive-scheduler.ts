import { col } from "../storage/hive.ts"
import type { JobDoc } from "../storage/collections.ts"

export const DEFAULT_MAX_AGENT_CONCURRENCY = 3
export const DEFAULT_MAX_REPAIR_CYCLES = 2

export interface ScheduledJobPayload {
  id: string
  description: string
  dependsOn: string[]
  feature_dir?: string
  completed?: boolean
}

export interface SchedulerResult {
  completed: string[]
  failed: Array<{ id: string; error: string }>
  blocked: string[]
  peakConcurrency: number
}

export type JobExecutor = (job: JobDoc, payload: ScheduledJobPayload) => Promise<unknown>

function payloadOf(job: JobDoc): ScheduledJobPayload {
  const parsed = JSON.parse(job.payload_json) as Partial<ScheduledJobPayload>
  return {
    id: parsed.id || job.id,
    description: parsed.description || "",
    dependsOn: Array.isArray(parsed.dependsOn) ? parsed.dependsOn : [],
    feature_dir: parsed.feature_dir,
    completed: parsed.completed,
  }
}

function ownerProcessAlive(owner: string): boolean {
  const match = /^scheduler:(\d+)$/.exec(owner)
  if (!match) return false
  try {
    process.kill(Number(match[1]), 0)
    return true
  } catch {
    return false
  }
}

/**
 * Durable, dependency-aware scheduler. It claims only ready nodes and never
 * runs more than `maxConcurrency` model invocations at once.
 */
export class AdaptiveScheduler {
  constructor(
    private readonly maxConcurrency = DEFAULT_MAX_AGENT_CONCURRENCY,
    private readonly leaseSeconds = 3600,
  ) {
    if (maxConcurrency < 1 || maxConcurrency > DEFAULT_MAX_AGENT_CONCURRENCY) {
      throw new Error(`maxConcurrency must be between 1 and ${DEFAULT_MAX_AGENT_CONCURRENCY}`)
    }
  }

  async run(runId: string, execute: JobExecutor): Promise<SchedulerResult> {
    const jobsCol = await col<JobDoc>("jobQueue")
    const all = (await jobsCol.findBy("run_id", runId)).map(entry => ({ ...entry, payload: payloadOf(entry.doc) }))
    const now = Math.floor(Date.now() / 1000)
    for (const entry of all) {
      const abandoned = (entry.doc.status === "claimed" || entry.doc.status === "running")
        && (entry.doc.lease_expires_at <= now || !ownerProcessAlive(entry.doc.lease_owner))
      if (entry.doc.status === "interrupted" || abandoned) {
        entry.doc.status = "pending"
        entry.doc.lease_owner = ""
        entry.doc.lease_expires_at = 0
        entry.doc.updated_at = now
        await jobsCol.put(entry.doc.id, entry.doc, { expectedVersion: entry.version })
        const reconciled = await jobsCol.get(entry.doc.id)
        entry.version = reconciled?.version ?? entry.version + 1
      }
    }
    const completed = new Set(
      all.filter(entry => entry.doc.status === "completed").map(entry => entry.payload.id),
    )
    const failed: Array<{ id: string; error: string }> = all
      .filter(entry => entry.doc.status === "failed")
      .map(entry => ({ id: entry.payload.id, error: entry.doc.error || "failed in a previous run" }))
    let peakConcurrency = 0
    if (failed.length > 0) {
      return {
        completed: [...completed],
        failed,
        blocked: all.filter(entry => entry.doc.status === "pending").map(entry => entry.payload.id),
        peakConcurrency,
      }
    }

    while (true) {
      const pending = all.filter(entry => entry.doc.status === "pending")
      if (pending.length === 0) break
      const candidates = pending
        .filter(entry => entry.payload.dependsOn.every(dep => completed.has(dep)))
      const ready: typeof candidates = []
      let mutatingSelected = false
      for (const candidate of candidates) {
        const readOnly = ["scout", "verifier", "reviewer"].includes(candidate.doc.lane)
        if (!readOnly && mutatingSelected) continue
        ready.push(candidate)
        if (!readOnly) mutatingSelected = true
        if (ready.length === this.maxConcurrency) break
      }
      if (ready.length === 0) break
      peakConcurrency = Math.max(peakConcurrency, ready.length)

      await Promise.all(ready.map(async entry => {
        const now = Math.floor(Date.now() / 1000)
        entry.doc.status = "running"
        entry.doc.attempts += 1
        entry.doc.lease_owner = `scheduler:${process.pid}`
        entry.doc.lease_expires_at = now + this.leaseSeconds
        entry.doc.updated_at = now
        await jobsCol.put(entry.doc.id, entry.doc, { expectedVersion: entry.version })
        const claimed = await jobsCol.get(entry.doc.id)
        entry.version = claimed?.version ?? entry.version + 1

        try {
          await execute(entry.doc, entry.payload)
          entry.doc.status = "completed"
          entry.doc.completed_at = Math.floor(Date.now() / 1000)
          entry.doc.error = null
          completed.add(entry.payload.id)
        } catch (error) {
          const message = (error as Error).message
          entry.doc.error = message
          entry.doc.status = entry.doc.attempts < entry.doc.max_attempts ? "pending" : "failed"
          if (entry.doc.status === "failed") failed.push({ id: entry.payload.id, error: message })
        }
        entry.doc.updated_at = Math.floor(Date.now() / 1000)
        entry.doc.lease_owner = ""
        entry.doc.lease_expires_at = 0
        await jobsCol.put(entry.doc.id, entry.doc, { expectedVersion: entry.version })
        const updated = await jobsCol.get(entry.doc.id)
        entry.version = updated?.version ?? entry.version + 1
      }))

      if (failed.length) break
    }

    const blocked = all
      .filter(entry => entry.doc.status === "pending")
      .map(entry => entry.payload.id)
    return { completed: [...completed], failed, blocked, peakConcurrency }
  }
}

export type TaskComplexity = "conversation" | "simple_change" | "complex"

export function classifyTask(objective: string): TaskComplexity {
  const text = objective.trim().toLowerCase()
  if (!text) return "conversation"
  const complexSignals = [
    /\b(architecture|arquitectura|migration|migraci[oó]n)\b/,
    /\b(new feature|nueva funcionalidad|large refactor|refactor amplio)\b/,
    /\b(redesign|rediseñ|cross[- ]cutting|multi[- ]module|breaking change)\b/,
    /\b(database schema|esquema de base de datos|distributed|distribuid[oa])\b/,
    /\b(landing page|website|sitio web|aplicaci[oó]n web)\b/,
    /\b(crea(?:r|s)?|create|build|construye|desarrolla)\b.{0,80}\b(proyecto|project|app|aplicaci[oó]n|sitio)\b/,
  ]
  if (complexSignals.some(pattern => pattern.test(text)) || text.length > 600) return "complex"

  const mutationSignals = /\b(implement|implementa|fix|corrige|cambia|change|add|agrega|crea(?:r|s)?|create|remove|elimina|refactor)\b/
  return mutationSignals.test(text) ? "simple_change" : "conversation"
}
