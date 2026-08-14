import { col } from "@johpaz/hivecode-core/storage/hive"
import { computeBackoffDelay } from "@johpaz/hivecode-core/utils/retry"
import type { CronJobDoc } from "@johpaz/hivecode-core/storage/collections"
import { Scribe } from "../narrative/scribe.ts"
import { classifyError } from "../errors/classify-error.ts"
import type { HiveError } from "../errors/hive-errors.ts"

const MAX_RETRIES = 3

/** Exponential backoff between task-level retries: ~15s, ~30s, ~60s (with jitter). */
const RETRY_BACKOFF = { initialDelayMs: 15_000, backoffMultiplier: 2, maxDelayMs: 120_000 }

export interface RetryPayload {
  _recovery: true
  originalTask: string
  sessionId: string
  taskId: string
  errorClass: string
  errorMessage: string
  failureId: number
  retryCount: number
  maxRetries: number
  mode: "auto" | "approval"
}

export interface ScheduleRetryParams {
  error: HiveError
  task: string
  sessionId: string
  taskId: string
  mode: "auto" | "approval"
  retryCount?: number
}

export class FailureRecoveryScheduler {
  private static instance: FailureRecoveryScheduler | null = null
  private scribe = new Scribe()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  static getInstance(): FailureRecoveryScheduler {
    if (!FailureRecoveryScheduler.instance) {
      FailureRecoveryScheduler.instance = new FailureRecoveryScheduler()
    }
    return FailureRecoveryScheduler.instance
  }

  hasPendingRetry(taskId: string): boolean {
    return this.timers.has(taskId)
  }

  async waitForRetry(taskId: string): Promise<void> {
    if (!this.timers.has(taskId)) return
    return new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (!this.timers.has(taskId)) {
          clearInterval(check)
          resolve()
        }
      }, 1000)
    })
  }

  async scheduleRetry(params: ScheduleRetryParams): Promise<void> {
    const { error, task, sessionId, taskId, mode } = params
    const retryCount = params.retryCount ?? 1

    // Persist the failure to learning_failures
    const failureType = error.errorClass === "TimeoutError" ? "timeout" : "tool_error"
    this.scribe.writeFailure({
      taskId,
      phaseId: null,
      agent: "process",
      failureType,
      errorMessage: error.message,
      contextSummary: `Process-level ${error.errorClass} during task execution (retry ${retryCount}/${MAX_RETRIES})`,
    })

    const failureId = Date.now()

    if (retryCount > MAX_RETRIES) {
      await this.writeEscalation({ taskId, failureId, retryCount, task, error })
      return
    }

    const payload: RetryPayload = {
      _recovery: true,
      originalTask: task,
      sessionId,
      taskId,
      errorClass: error.errorClass,
      errorMessage: error.message,
      failureId,
      retryCount,
      maxRetries: MAX_RETRIES,
      mode,
    }

    const delayMs = computeBackoffDelay(retryCount, RETRY_BACKOFF)
    const fireAt = new Date(Date.now() + delayMs)
    this.persistCronJob(payload, fireAt)

    process.stdout.write(
      `\n⚠️  Fallo (${error.errorClass}): ${error.message}\n` +
      `   Reintentando en ${Math.round(delayMs / 1000)}s (intento ${retryCount}/${MAX_RETRIES})...\n\n`
    )

    const timer = setTimeout(async () => {
      this.timers.delete(taskId)
      await this.executeRetry(payload)
    }, delayMs)

    this.timers.set(taskId, timer)
  }

  private async executeRetry(payload: RetryPayload): Promise<void> {
    this.markCronJobCompleted(payload.taskId, payload.retryCount)

    process.stdout.write(
      `\n🔄 Reintentando tarea (intento ${payload.retryCount}/${MAX_RETRIES})...\n\n`
    )

    // Lazy import to avoid circular deps — CoordinatorManager imports from this package
    const { CoordinatorManager } = await import("../workers/coordinator-manager.ts")
    const manager = new CoordinatorManager()

    try {
      await manager.startAll()
      await manager.runTask(payload.originalTask, payload.mode)
      process.stdout.write(`\n✅ Tarea completada en el intento ${payload.retryCount}.\n\n`)
    } catch (rawErr) {
      const err = classifyError(rawErr)
      await this.scheduleRetry({
        error: err,
        task: payload.originalTask,
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        mode: payload.mode,
        retryCount: payload.retryCount + 1,
      })
    } finally {
      await manager.stopAll()
    }
  }

  private async writeEscalation(params: {
    taskId: string
    failureId: number
    retryCount: number
    task: string
    error: HiveError
  }): Promise<void> {
    // ForensicAgent activation, condition 2: a task retried MAX_RETRIES times without
    // ever succeeding (condition 1 — a single worker exhausting its iteration budget —
    // is handled inside CoordinatorManager's normal phase loop). Root-cause analysis
    // before escalating gives the human a diagnosis instead of just a raw error.
    let forensicAnalysis = ""
    try {
      const { CoordinatorManager } = await import("../workers/coordinator-manager.ts")
      const manager = new CoordinatorManager()
      await manager.startAll()
      try {
        const result = await manager.analyzeFailure(params.task, `${params.error.errorClass}: ${params.error.message}`)
        forensicAnalysis = result.narrativeEntry || ""
      } finally {
        await manager.stopAll()
      }
    } catch (forensicErr) {
      forensicAnalysis = `(ForensicAgent analysis failed: ${(forensicErr as Error).message})`
    }

    try {
      this.scribe.writeProposal({
        sourceAgent: "failure-recovery-scheduler",
        proposalType: "escalate_to_human",
        description: `Tarea falló ${MAX_RETRIES} veces consecutivas. ` +
          `Último error: ${params.error.errorClass} — ${params.error.message}. ` +
          `Tarea: "${params.task.slice(0, 200)}"\n\nAnálisis de ForensicAgent:\n${forensicAnalysis}`,
        failureIds: [params.failureId],
      })
    } catch {
      // Don't block escalation message if DB write fails
    }

    process.stdout.write(
      `\n❌ La tarea falló ${MAX_RETRIES} veces. Escalando a revisión humana.\n` +
      `   Análisis de ForensicAgent:\n${forensicAnalysis}\n\n` +
      `   Revisa learning_proposals en la BD para el diagnóstico completo.\n\n`
    )

    process.exit(1)
  }

  private persistCronJob(payload: RetryPayload, fireAt: Date): void {
    void (async () => {
      try {
        const cronJobs = await col<CronJobDoc>("cronJobs")
        const id = `recovery-${payload.taskId}-r${payload.retryCount}`
        const existing = await cronJobs.get(id)
        const now = new Date().toISOString()
        await cronJobs.put(id, {
          id,
          name: `Recovery retry ${payload.retryCount}/${payload.maxRetries}`,
          task: `Retry: ${payload.originalTask.slice(0, 100)}`,
          task_type: "one_shot",
          cron_expression: null,
          fire_at: fireAt.toISOString(),
          timezone: "UTC",
          start_at: null,
          stop_at: null,
          dom_and_dow: false,
          max_runs: 1,
          protect: false,
          interval_sec: null,
          agent_id: "system",
          channel: "system",
          payload: JSON.stringify(payload),
          tool_name: null,
          status: "active",
          run_count: existing?.doc.run_count ?? 0,
          error_count: existing?.doc.error_count ?? 0,
          last_error: null,
          created_at: existing?.doc.created_at ?? now,
          updated_at: now,
          last_run_at: existing?.doc.last_run_at ?? null,
          next_run_at: fireAt.toISOString(),
          completed_at: null,
        }, { expectedVersion: existing?.version ?? 0 })
      } catch {
        // Non-blocking.
      }
    })()
  }

  private markCronJobCompleted(taskId: string, retryCount: number): void {
    void (async () => {
      try {
        const cronJobs = await col<CronJobDoc>("cronJobs")
        const id = `recovery-${taskId}-r${retryCount}`
        const existing = await cronJobs.get(id)
        if (!existing) return
        await cronJobs.put(id, {
          ...existing.doc,
          status: "completed",
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        }, { expectedVersion: existing.version })
      } catch {
        // Non-blocking.
      }
    })()
  }
}
