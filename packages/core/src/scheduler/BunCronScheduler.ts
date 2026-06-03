/**
 * BunCronScheduler — Implementación nativa con Bun.cron
 *
 * Implementa CronScheduler usando la API built-in de Bun:
 * - Tareas recurrentes: Bun.cron() con expresión ajustada a UTC
 * - Tareas one_shot:   setTimeout() con delay calculado desde fire_at
 * - Startup:           reconcilia todos los jobs activos de la BD
 *
 * Limitación conocida: el ajuste de timezone es estático (calculado al registrar).
 * Los jobs en zonas con DST se desajustan una hora en el cambio de horario.
 */

import { getDb } from "../storage/sqlite";
import { logger } from "../utils/logger";
import type {
  CronScheduler,
  CronTaskInput,
  CronTask,
  CronCreateResult,
  CronStatusEntry,
} from "./CronScheduler";

const log = logger.child("BunCronScheduler");

// ─── Tipos internos ──────────────────────────────────────────────────────────

export interface DbCronRow {
  id: string;
  name: string;
  task: string;
  task_type: string;
  status: string;
  cron_expression: string | null;
  fire_at: string | null;
  timezone: string;
  start_at: string | null;
  stop_at: string | null;
  max_runs: number | null;
  protect: number;
  interval_sec: number | null;
  agent_id: string | null;
  channel: string;
  payload: string;
  tool_name: string | null;
  run_count: number;
  error_count: number;
  next_run_at: string | null;
  last_run_at: string | null;
}

type Handle = {
  job?: { stop(): void };
  timeout?: ReturnType<typeof setTimeout>;
};

export type ExecuteCallback = (task: DbCronRow) => Promise<void>;

// ─── Helpers de timezone y cron ──────────────────────────────────────────────

function getTimezoneOffsetHours(timezone: string): number {
  try {
    const now = new Date();
    const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
    const tzStr = now.toLocaleString("en-US", { timeZone: timezone });
    return Math.round((new Date(utcStr).getTime() - new Date(tzStr).getTime()) / 3600000);
  } catch {
    return 0;
  }
}

/**
 * Ajusta el campo HOUR de una expresión cron de `timezone` a UTC.
 * Solo maneja horas como enteros simples — rangos/listas/pasos quedan sin tocar.
 */
function toUtcCron(expr: string, timezone: string): string {
  if (!timezone || timezone === "UTC") return expr;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const hour = parseInt(parts[1], 10);
  if (isNaN(hour)) return expr;
  const offset = getTimezoneOffsetHours(timezone);
  parts[1] = String(((hour + offset) % 24 + 24) % 24);
  return parts.join(" ");
}

/**
 * Expande un campo cron (ej. "1-5/2", "0,15,30,45", "*") a un array de valores.
 */
function expandField(field: string, min: number, max: number): number[] {
  if (field === "*") return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  const result = new Set<number>();
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [rangePart, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10) || 1;
      const [startStr, endStr] = (rangePart === "*" ? `${min}-${max}` : rangePart).split("-");
      for (let v = parseInt(startStr, 10); v <= (endStr ? parseInt(endStr, 10) : max); v += step) {
        result.add(v);
      }
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      for (let v = parseInt(startStr, 10); v <= parseInt(endStr, 10); v++) result.add(v);
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * Calcula la próxima ejecución de una expresión cron UTC.
 * Retorna ISO string o null si no puede calcularse.
 */
function computeNextRun(utcExpr: string): string | null {
  try {
    const parts = utcExpr.trim().split(/\s+/);
    if (parts.length < 5) return null;
    const validMins = expandField(parts[0], 0, 59);
    const validHours = expandField(parts[1], 0, 23);
    const validDoms = expandField(parts[2], 1, 31);
    const validMons = expandField(parts[3], 1, 12);
    const validDows = expandField(parts[4], 0, 6);

    const candidate = new Date();
    candidate.setUTCSeconds(0, 0);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

    // Buscar hasta 1 año adelante (minuto a minuto, 527040 iteraciones máx)
    for (let i = 0; i < 527040; i++) {
      if (
        validMons.includes(candidate.getUTCMonth() + 1) &&
        validDoms.includes(candidate.getUTCDate()) &&
        validDows.includes(candidate.getUTCDay()) &&
        validHours.includes(candidate.getUTCHours()) &&
        validMins.includes(candidate.getUTCMinutes())
      ) {
        return candidate.toISOString();
      }
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    }
    return null;
  } catch {
    return null;
  }
}

function rowToTask(row: DbCronRow): CronTask {
  return {
    id: row.id,
    name: row.name,
    task: row.task,
    task_type: row.task_type,
    status: row.status,
    cron_expression: row.cron_expression,
    fire_at: row.fire_at,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    run_count: row.run_count,
    channel: row.channel,
  };
}

// ─── BunCronScheduler ─────────────────────────────────────────────────────────

export class BunCronScheduler implements CronScheduler {
  private handles = new Map<string, Handle>();
  private executeCallback: ExecuteCallback;

  constructor(executeCallback: ExecuteCallback) {
    this.executeCallback = executeCallback;
  }

  /**
   * Cargar todos los jobs activos de la BD y registrarlos con Bun.cron/setTimeout.
   * Llamar una sola vez al arrancar el gateway.
   */
  async startup(): Promise<void> {
    const db = getDb();
    const rows = db
      .query(`SELECT * FROM cron_jobs WHERE status = 'active' ORDER BY created_at ASC`)
      .all() as DbCronRow[];

    let registered = 0;
    for (const row of rows) {
      try {
        this._register(row);
        registered++;
      } catch (err) {
        log.warn(`[startup] Failed to register "${row.name}" (${row.id}): ${(err as Error).message}`);
      }
    }
    log.info(`[startup] ${registered}/${rows.length} cron jobs registered`);
  }

  // ─── CronScheduler interface ──────────────────────────────────────────────

  create(input: CronTaskInput): CronCreateResult {
    const db = getDb();
    const { id: taskId } = db.query(`SELECT lower(hex(randomblob(8))) AS id`).get() as { id: string };

    const utcExpr = input.cron_expression
      ? toUtcCron(input.cron_expression, input.timezone)
      : null;
    const nextRun = utcExpr ? computeNextRun(utcExpr) : null;

    db.query(`
      INSERT INTO cron_jobs (
        id, name, task, task_type, cron_expression, fire_at, timezone,
        start_at, stop_at, dom_and_dow, max_runs, protect, interval_sec,
        agent_id, channel, payload, tool_name, status, next_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      taskId,
      input.name,
      input.task,
      input.task_type,
      input.cron_expression ?? null,
      input.fire_at ?? null,
      input.timezone || "UTC",
      input.start_at ?? null,
      input.stop_at ?? null,
      input.dom_and_dow ? 1 : 0,
      input.max_runs ?? null,
      input.protect !== false ? 1 : 0,
      input.interval_sec ?? null,
      input.agent_id ?? null,
      input.channel || "system",
      JSON.stringify(input.payload ?? {}),
      input.tool_name ?? null,
      nextRun,
    );

    const row = db.query(`SELECT * FROM cron_jobs WHERE id = ?`).get(taskId) as DbCronRow;
    this._register(row);

    log.info(`[create] "${input.name}" (${taskId}) — next: ${nextRun ?? "N/A"}`);
    return { id: taskId, nextRun: nextRun ?? undefined };
  }

  update(taskId: string, changes: Record<string, unknown>): boolean {
    const db = getDb();
    const current = db.query(`SELECT * FROM cron_jobs WHERE id = ?`).get(taskId) as DbCronRow | null;
    if (!current) return false;

    const allowed = new Set([
      "name", "task", "cron_expression", "fire_at", "timezone", "channel",
      "max_runs", "start_at", "stop_at", "agent_id", "payload", "tool_name",
    ]);
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(changes)) {
      if (allowed.has(k)) { fields.push(`${k} = ?`); values.push(v); }
    }
    if (fields.length === 0) return false;

    db.query(`UPDATE cron_jobs SET ${fields.join(", ")} WHERE id = ?`).run(...([...values, taskId] as any));

    if (current.status === "active") {
      this._stop(taskId);
      const updated = db.query(`SELECT * FROM cron_jobs WHERE id = ?`).get(taskId) as DbCronRow;
      this._register(updated);
    }
    log.info(`[update] Job ${taskId} updated`);
    return true;
  }

  pause(taskId: string): boolean {
    const db = getDb();
    const row = db.query(`SELECT status FROM cron_jobs WHERE id = ?`).get(taskId) as { status: string } | null;
    if (!row || row.status !== "active") return false;
    this._stop(taskId);
    db.query(`UPDATE cron_jobs SET status = 'paused' WHERE id = ?`).run(taskId);
    log.info(`[pause] Job ${taskId} paused`);
    return true;
  }

  resume(taskId: string): boolean {
    const db = getDb();
    const row = db.query(`SELECT * FROM cron_jobs WHERE id = ?`).get(taskId) as DbCronRow | null;
    if (!row || row.status !== "paused") return false;

    const utcExpr = row.cron_expression ? toUtcCron(row.cron_expression, row.timezone) : null;
    const nextRun = utcExpr ? computeNextRun(utcExpr) : null;
    db.query(`UPDATE cron_jobs SET status = 'active', next_run_at = ? WHERE id = ?`).run(nextRun, taskId);

    this._register({ ...row, status: "active" });
    log.info(`[resume] Job ${taskId} resumed — next: ${nextRun ?? "N/A"}`);
    return true;
  }

  delete(taskId: string): boolean {
    const db = getDb();
    this._stop(taskId);
    const result = db.query(`DELETE FROM cron_jobs WHERE id = ?`).run(taskId) as { changes: number };
    if (result.changes > 0) { log.info(`[delete] Job ${taskId} deleted`); return true; }
    return false;
  }

  trigger(taskId: string): boolean {
    const db = getDb();
    const row = db.query(`SELECT * FROM cron_jobs WHERE id = ?`).get(taskId) as DbCronRow | null;
    if (!row) return false;
    this._executeJob(row).catch(err =>
      log.error(`[trigger] Job ${taskId} execution error:`, err)
    );
    return true;
  }

  listTasks(status?: string): CronTask[] {
    const db = getDb();
    const rows = (status
      ? db.query(`SELECT * FROM cron_jobs WHERE status = ? ORDER BY next_run_at ASC`).all(status)
      : db.query(`SELECT * FROM cron_jobs ORDER BY created_at DESC`).all()
    ) as DbCronRow[];
    return rows.map(rowToTask);
  }

  getTask(taskId: string): CronTask | null {
    const db = getDb();
    const row = db.query(`SELECT * FROM cron_jobs WHERE id = ?`).get(taskId) as DbCronRow | null;
    return row ? rowToTask(row) : null;
  }

  getStatus(): CronStatusEntry[] {
    const db = getDb();
    const rows = db
      .query(`SELECT id, name, status, next_run_at, last_run_at FROM cron_jobs ORDER BY created_at ASC`)
      .all() as { id: string; name: string; status: string; next_run_at: string | null; last_run_at: string | null }[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      status: r.status,
      nextRun: r.next_run_at ?? undefined,
      lastRun: r.last_run_at ?? undefined,
    }));
  }

  // ─── Privados ─────────────────────────────────────────────────────────────

  private _register(row: DbCronRow): void {
    this._stop(row.id);

    if (row.task_type === "recurring" && row.cron_expression) {
      const utcExpr = toUtcCron(row.cron_expression, row.timezone);
      const job = Bun.cron(utcExpr as any, () => { this._fireJob(row.id); });
      this.handles.set(row.id, { job });
      log.debug(`[register] Recurring "${row.name}" → "${utcExpr}"`);
    } else if (row.task_type === "one_shot" && row.fire_at) {
      const delay = new Date(row.fire_at).getTime() - Date.now();
      if (delay <= 0) {
        log.warn(`[register] One-shot "${row.name}" fire_at is in the past — skipping`);
        return;
      }
      const timeout = setTimeout(() => { this._fireJob(row.id); }, delay);
      this.handles.set(row.id, { timeout });
      log.debug(`[register] One-shot "${row.name}" in ${Math.round(delay / 1000)}s`);
    }
  }

  private _stop(taskId: string): void {
    const h = this.handles.get(taskId);
    if (h?.job) h.job.stop();
    if (h?.timeout !== undefined) clearTimeout(h.timeout);
    this.handles.delete(taskId);
  }

  private _fireJob(taskId: string): void {
    const db = getDb();
    const row = db.query(`SELECT * FROM cron_jobs WHERE id = ?`).get(taskId) as DbCronRow | null;
    if (!row || row.status !== "active") return;

    const now = new Date();
    if (row.start_at && now < new Date(row.start_at)) return;
    if (row.stop_at && now > new Date(row.stop_at)) {
      db.query(`UPDATE cron_jobs SET status = 'completed', completed_at = ? WHERE id = ?`)
        .run(now.toISOString(), taskId);
      this._stop(taskId);
      return;
    }

    this._executeJob(row).catch(err =>
      log.error(`[fire] "${row.name}" (${taskId}) error:`, err)
    );
  }

  private async _executeJob(row: DbCronRow): Promise<void> {
    const db = getDb();
    const { id: runId } = db.query(`SELECT lower(hex(randomblob(8))) AS id`).get() as { id: string };
    const startedAt = new Date().toISOString();

    db.query(`
      INSERT INTO task_runs (id, task_id, status, started_at, payload_snapshot)
      VALUES (?, ?, 'running', ?, ?)
    `).run(runId, row.id, startedAt, row.payload);

    db.query(`UPDATE cron_jobs SET last_run_at = ?, run_count = run_count + 1 WHERE id = ?`)
      .run(startedAt, row.id);

    const t0 = Date.now();
    let success = true;
    let errorMsg: string | null = null;

    try {
      await this.executeCallback(row);
    } catch (err) {
      success = false;
      errorMsg = (err as Error).message;
      db.query(`UPDATE cron_jobs SET error_count = error_count + 1, last_error = ? WHERE id = ?`)
        .run(errorMsg, row.id);
      log.error(`[execute] "${row.name}" failed: ${errorMsg}`);
    }

    const durationMs = Date.now() - t0;
    const finishedAt = new Date().toISOString();

    db.query(`
      UPDATE task_runs SET status = ?, finished_at = ?, duration_ms = ?, error_message = ?
      WHERE id = ?
    `).run(success ? "success" : "failed", finishedAt, durationMs, errorMsg, runId);

    // Verificar max_runs
    if (row.max_runs !== null) {
      const updated = db.query(`SELECT run_count FROM cron_jobs WHERE id = ?`).get(row.id) as { run_count: number } | null;
      if (updated && updated.run_count >= row.max_runs) {
        db.query(`UPDATE cron_jobs SET status = 'completed', completed_at = ? WHERE id = ?`)
          .run(finishedAt, row.id);
        this._stop(row.id);
        log.info(`[execute] "${row.name}" completed after ${updated.run_count} runs`);
        return;
      }
    }

    // One-shot: completar después de la primera ejecución
    if (row.task_type === "one_shot") {
      db.query(`UPDATE cron_jobs SET status = 'completed', completed_at = ? WHERE id = ?`)
        .run(finishedAt, row.id);
      this._stop(row.id);
    } else if (row.cron_expression) {
      // Actualizar next_run_at para jobs recurrentes
      const utcExpr = toUtcCron(row.cron_expression, row.timezone);
      const nextRun = computeNextRun(utcExpr);
      db.query(`UPDATE cron_jobs SET next_run_at = ? WHERE id = ?`).run(nextRun, row.id);
    }
  }
}
