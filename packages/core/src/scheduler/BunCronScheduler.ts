/**
 * BunCronScheduler - native Bun.cron scheduler backed by HiveDB.
 */

import { col } from "../storage/hive";
import type { CronJobDoc, TaskRunDoc } from "../storage/collections";
import { logger } from "../utils/logger";
import type {
  CronScheduler,
  CronTaskInput,
  CronTask,
  CronCreateResult,
  CronStatusEntry,
} from "./CronScheduler";

const log = logger.child("BunCronScheduler");

type Handle = {
  job?: { stop(): void };
  timeout?: ReturnType<typeof setTimeout>;
};

export type ExecuteCallback = (task: CronJobDoc) => Promise<void>;

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

function toUtcCron(expr: string, timezone: string): string {
  if (!timezone || timezone === "UTC") return expr;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const hour = parseInt(parts[1], 10);
  if (Number.isNaN(hour)) return expr;
  const offset = getTimezoneOffsetHours(timezone);
  parts[1] = String(((hour + offset) % 24 + 24) % 24);
  return parts.join(" ");
}

function expandField(field: string, min: number, max: number): number[] {
  if (field === "*") return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  const result = new Set<number>();
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [rangePart, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10) || 1;
      const [startStr, endStr] = (rangePart === "*" ? `${min}-${max}` : rangePart).split("-");
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : max;
      for (let v = start; v <= end; v += step) result.add(v);
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      for (let v = parseInt(startStr, 10); v <= parseInt(endStr, 10); v++) result.add(v);
    } else {
      const n = parseInt(part, 10);
      if (!Number.isNaN(n)) result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}

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

function nextRunFor(input: Pick<CronJobDoc, "task_type" | "cron_expression" | "fire_at" | "timezone">): string | null {
  if (input.task_type === "one_shot") return input.fire_at ?? null;
  if (!input.cron_expression) return null;
  return computeNextRun(toUtcCron(input.cron_expression, input.timezone));
}

function rowToTask(row: CronJobDoc): CronTask {
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

async function patchCronJob(id: string, patch: Partial<CronJobDoc>): Promise<CronJobDoc | null> {
  const jobs = await col<CronJobDoc>("cronJobs");
  const existing = await jobs.get(id);
  if (!existing) return null;
  const updated = { ...existing.doc, ...patch, updated_at: new Date().toISOString() };
  await jobs.put(id, updated, { expectedVersion: existing.version });
  return updated;
}

export class BunCronScheduler implements CronScheduler {
  private handles = new Map<string, Handle>();
  private executeCallback: ExecuteCallback;

  constructor(executeCallback: ExecuteCallback) {
    this.executeCallback = executeCallback;
  }

  async startup(): Promise<void> {
    const rows = (await (await col<CronJobDoc>("cronJobs")).findBy("status", "active"))
      .map((entry) => entry.doc)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    let registered = 0;
    for (const row of rows) {
      try {
        this.register(row);
        registered++;
      } catch (err) {
        log.warn(`[startup] Failed to register "${row.name}" (${row.id}): ${(err as Error).message}`);
      }
    }
    log.info(`[startup] ${registered}/${rows.length} cron jobs registered`);
  }

  async create(input: CronTaskInput): Promise<CronCreateResult> {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const now = new Date().toISOString();
    const base: CronJobDoc = {
      id,
      name: input.name,
      task: input.task,
      task_type: input.task_type,
      cron_expression: input.cron_expression ?? null,
      fire_at: input.fire_at ?? null,
      timezone: input.timezone || "UTC",
      start_at: input.start_at ?? null,
      stop_at: input.stop_at ?? null,
      dom_and_dow: !!input.dom_and_dow,
      max_runs: input.max_runs ?? null,
      protect: input.protect !== false,
      interval_sec: input.interval_sec ?? null,
      agent_id: input.agent_id ?? "",
      channel: input.channel || "system",
      payload: JSON.stringify(input.payload ?? {}),
      tool_name: input.tool_name ?? null,
      status: "active",
      run_count: 0,
      error_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
      last_run_at: null,
      next_run_at: null,
      completed_at: null,
    };
    const doc = { ...base, next_run_at: nextRunFor(base) };

    await (await col<CronJobDoc>("cronJobs")).put(id, doc, { expectedVersion: 0 });
    this.register(doc);

    log.info(`[create] "${input.name}" (${id}) - next: ${doc.next_run_at ?? "N/A"}`);
    return { id, nextRun: doc.next_run_at };
  }

  async update(taskId: string, changes: Record<string, unknown>): Promise<boolean> {
    const jobs = await col<CronJobDoc>("cronJobs");
    const current = await jobs.get(taskId);
    if (!current) return false;

    const allowed = new Set([
      "name", "task", "cron_expression", "fire_at", "timezone", "channel",
      "max_runs", "start_at", "stop_at", "agent_id", "payload", "tool_name",
      "dom_and_dow", "protect", "interval_sec",
    ]);
    const patch: Partial<CronJobDoc> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.has(key)) continue;
      if (key === "payload") patch.payload = typeof value === "string" ? value : JSON.stringify(value ?? {});
      else if (key === "dom_and_dow" || key === "protect") (patch as any)[key] = !!value;
      else (patch as any)[key] = value ?? null;
    }
    if (Object.keys(patch).length === 0) return false;

    const merged = { ...current.doc, ...patch };
    patch.next_run_at = nextRunFor(merged);
    patch.updated_at = new Date().toISOString();
    const updated = { ...current.doc, ...patch };
    await jobs.put(taskId, updated, { expectedVersion: current.version });

    if (updated.status === "active") {
      this.stop(taskId);
      this.register(updated);
    }
    log.info(`[update] Job ${taskId} updated`);
    return true;
  }

  async pause(taskId: string): Promise<boolean> {
    const entry = await (await col<CronJobDoc>("cronJobs")).get(taskId);
    if (!entry || entry.doc.status !== "active") return false;
    this.stop(taskId);
    await patchCronJob(taskId, { status: "paused" });
    log.info(`[pause] Job ${taskId} paused`);
    return true;
  }

  async resume(taskId: string): Promise<boolean> {
    const entry = await (await col<CronJobDoc>("cronJobs")).get(taskId);
    if (!entry || entry.doc.status !== "paused") return false;
    const updated = await patchCronJob(taskId, {
      status: "active",
      next_run_at: nextRunFor(entry.doc),
    });
    if (!updated) return false;
    this.register(updated);
    log.info(`[resume] Job ${taskId} resumed - next: ${updated.next_run_at ?? "N/A"}`);
    return true;
  }

  async delete(taskId: string): Promise<boolean> {
    const jobs = await col<CronJobDoc>("cronJobs");
    if (!(await jobs.get(taskId))) return false;
    this.stop(taskId);
    await jobs.delete(taskId);
    log.info(`[delete] Job ${taskId} deleted`);
    return true;
  }

  async trigger(taskId: string): Promise<boolean> {
    const row = (await (await col<CronJobDoc>("cronJobs")).get(taskId))?.doc;
    if (!row) return false;
    this.executeJob(row).catch((err) =>
      log.error(`[trigger] Job ${taskId} execution error:`, err)
    );
    return true;
  }

  async listTasks(status?: string): Promise<CronTask[]> {
    const rows = status
      ? (await (await col<CronJobDoc>("cronJobs")).findBy("status", status)).map((entry) => entry.doc)
      : (await (await col<CronJobDoc>("cronJobs")).scan()).map((entry) => entry.doc);
    return rows
      .sort((a, b) => (a.next_run_at ?? a.created_at).localeCompare(b.next_run_at ?? b.created_at))
      .map(rowToTask);
  }

  async getTask(taskId: string): Promise<CronTask | null> {
    const row = (await (await col<CronJobDoc>("cronJobs")).get(taskId))?.doc;
    return row ? rowToTask(row) : null;
  }

  async getStatus(): Promise<CronStatusEntry[]> {
    const rows = (await (await col<CronJobDoc>("cronJobs")).scan())
      .map((entry) => entry.doc)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      nextRun: row.next_run_at ?? undefined,
      lastRun: row.last_run_at ?? undefined,
    }));
  }

  private register(row: CronJobDoc): void {
    this.stop(row.id);

    if (row.task_type === "recurring" && row.cron_expression) {
      const utcExpr = toUtcCron(row.cron_expression, row.timezone);
      const job = Bun.cron(utcExpr as any, () => { this.fireJob(row.id); });
      this.handles.set(row.id, { job });
      log.debug(`[register] Recurring "${row.name}" -> "${utcExpr}"`);
    } else if (row.task_type === "one_shot" && row.fire_at) {
      const delay = new Date(row.fire_at).getTime() - Date.now();
      if (delay <= 0) {
        log.warn(`[register] One-shot "${row.name}" fire_at is in the past - skipping`);
        return;
      }
      const timeout = setTimeout(() => { this.fireJob(row.id); }, delay);
      this.handles.set(row.id, { timeout });
      log.debug(`[register] One-shot "${row.name}" in ${Math.round(delay / 1000)}s`);
    }
  }

  private stop(taskId: string): void {
    const handle = this.handles.get(taskId);
    if (handle?.job) handle.job.stop();
    if (handle?.timeout !== undefined) clearTimeout(handle.timeout);
    this.handles.delete(taskId);
  }

  private fireJob(taskId: string): void {
    this.getRunnableJob(taskId).then((row) => {
      if (!row) return;
      this.executeJob(row).catch((err) =>
        log.error(`[fire] "${row.name}" (${taskId}) error:`, err)
      );
    }).catch((err) => log.error(`[fire] Failed to load job ${taskId}:`, err));
  }

  private async getRunnableJob(taskId: string): Promise<CronJobDoc | null> {
    const row = (await (await col<CronJobDoc>("cronJobs")).get(taskId))?.doc;
    if (!row || row.status !== "active") return null;

    const now = new Date();
    if (row.start_at && now < new Date(row.start_at)) return null;
    if (row.stop_at && now > new Date(row.stop_at)) {
      await patchCronJob(taskId, { status: "completed", completed_at: now.toISOString() });
      this.stop(taskId);
      return null;
    }
    return row;
  }

  private async executeJob(row: CronJobDoc): Promise<void> {
    const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const startedAt = new Date().toISOString();
    const runs = await col<TaskRunDoc>("taskRuns");
    await runs.put(runId, {
      id: runId,
      task_id: row.id,
      status: "running",
      started_at: startedAt,
      finished_at: null,
      duration_ms: null,
      error_message: null,
      payload_snapshot: row.payload,
      agent_response: null,
    }, { expectedVersion: 0 });

    await patchCronJob(row.id, {
      last_run_at: startedAt,
      run_count: row.run_count + 1,
    });

    const t0 = Date.now();
    let success = true;
    let errorMsg: string | null = null;

    try {
      await this.executeCallback(row);
    } catch (err) {
      success = false;
      errorMsg = (err as Error).message;
      await patchCronJob(row.id, {
        error_count: row.error_count + 1,
        last_error: errorMsg,
      });
      log.error(`[execute] "${row.name}" failed: ${errorMsg}`);
    }

    const durationMs = Date.now() - t0;
    const finishedAt = new Date().toISOString();
    const runEntry = await runs.get(runId);
    if (runEntry) {
      await runs.put(runId, {
        ...runEntry.doc,
        status: success ? "success" : "failed",
        finished_at: finishedAt,
        duration_ms: durationMs,
        error_message: errorMsg,
      }, { expectedVersion: runEntry.version });
    }

    const latest = (await (await col<CronJobDoc>("cronJobs")).get(row.id))?.doc;
    if (!latest) return;

    if (latest.max_runs !== null && latest.run_count >= latest.max_runs) {
      await patchCronJob(row.id, { status: "completed", completed_at: finishedAt });
      this.stop(row.id);
      log.info(`[execute] "${row.name}" completed after ${latest.run_count} runs`);
      return;
    }

    if (row.task_type === "one_shot") {
      await patchCronJob(row.id, { status: "completed", completed_at: finishedAt });
      this.stop(row.id);
    } else {
      await patchCronJob(row.id, { next_run_at: nextRunFor(latest) });
    }
  }
}
