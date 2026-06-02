import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { Scribe } from "../narrative/scribe.ts"
import { classifyError } from "../errors/classify-error.ts"
import type { HiveError } from "../errors/hive-errors.ts"

const MAX_RETRIES = 3

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

    const failureId = this.getLastInsertRowId()

    if (retryCount > MAX_RETRIES) {
      this.writeEscalation({ taskId, failureId, retryCount, task, error })
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

    const fireAt = new Date(Date.now() + 60_000)
    this.persistCronJob(payload, fireAt)

    process.stdout.write(
      `\n⚠️  Fallo (${error.errorClass}): ${error.message}\n` +
      `   Reintentando en 60 segundos (intento ${retryCount}/${MAX_RETRIES})...\n\n`
    )

    const timer = setTimeout(async () => {
      this.timers.delete(taskId)
      await this.executeRetry(payload)
    }, 60_000)

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

  private writeEscalation(params: {
    taskId: string
    failureId: number
    retryCount: number
    task: string
    error: HiveError
  }): void {
    try {
      this.scribe.writeProposal({
        sourceAgent: "failure-recovery-scheduler",
        proposalType: "escalate_to_human",
        description: `Tarea falló ${MAX_RETRIES} veces consecutivas. ` +
          `Último error: ${params.error.errorClass} — ${params.error.message}. ` +
          `Tarea: "${params.task.slice(0, 200)}"`,
        failureIds: [params.failureId],
      })
    } catch {
      // Don't block escalation message if DB write fails
    }

    process.stdout.write(
      `\n❌ La tarea falló ${MAX_RETRIES} veces. Escalando a revisión humana.\n` +
      `   Revisa learning_proposals en la BD para el diagnóstico.\n\n`
    )

    process.exit(1)
  }

  private persistCronJob(payload: RetryPayload, fireAt: Date): void {
    try {
      const db = getDb()
      db.query(`
        INSERT INTO cron_jobs (id, name, task, task_type, fire_at, timezone, payload, channel, status, created_at, updated_at)
        VALUES (?, ?, ?, 'one_shot', ?, 'UTC', ?, 'system', 'active', ?, ?)
      `).run(
        `recovery-${payload.taskId}-r${payload.retryCount}`,
        `Recovery retry ${payload.retryCount}/${payload.maxRetries}`,
        `Retry: ${payload.originalTask.slice(0, 100)}`,
        fireAt.toISOString(),
        JSON.stringify(payload),
        new Date().toISOString(),
        new Date().toISOString(),
      )
    } catch {
      // cron_jobs table may not exist in all deployments — non-blocking
    }
  }

  private markCronJobCompleted(taskId: string, retryCount: number): void {
    try {
      const db = getDb()
      db.query(`
        UPDATE cron_jobs SET status = 'completed', updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), `recovery-${taskId}-r${retryCount}`)
    } catch {
      // Non-blocking
    }
  }

  private getLastInsertRowId(): number {
    try {
      const db = getDb()
      const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()
      return row?.id ?? 0
    } catch {
      return 0
    }
  }
}
