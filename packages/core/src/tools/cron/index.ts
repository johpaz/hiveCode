/**
 * Cron tools for the Coordinator agent, backed by HiveDB.
 */

import type { Tool } from "../types";
import { col } from "../../storage/hive";
import type { ChannelDoc, CronJobDoc, TaskRunDoc, UserDoc, UserIdentityDoc } from "../../storage/collections";
import type { CronScheduler } from "../../scheduler/CronScheduler";
import { logger } from "../../utils/logger";

const log = logger.child("CronTools");

let scheduler: CronScheduler | null = null;

export function setSchedulerInstance(instance: CronScheduler): void {
  scheduler = instance;
}

export function getSchedulerInstance(): CronScheduler | null {
  return scheduler;
}

async function getUserTimezone(): Promise<string> {
  const user = (await (await col<UserDoc>("users")).scan()).map((entry) => entry.doc)[0];
  return user?.timezone || "UTC";
}

export async function resolveBestChannel(userId: string, explicitChannel?: string): Promise<string> {
  const users = await col<UserDoc>("users");
  const user = (await users.get(userId))?.doc;
  const identities = (await (await col<UserIdentityDoc>("userIdentities")).findBy("user_id", userId)).map((entry) => entry.doc);
  const connectedTypes = new Set((await (await col<ChannelDoc>("channels")).scan())
    .map((entry) => entry.doc)
    .filter((channel) => channel.active && channel.status === "connected")
    .map((channel) => channel.type));

  const activeIdentities = identities.filter((identity) => connectedTypes.has(identity.channel));
  const candidates = activeIdentities.length > 0 ? activeIdentities : identities;

  log.debug(`[resolveBestChannel] userId=${userId}, explicit=${explicitChannel}, preferred=${user?.preferred_cron_channel}, candidates=[${candidates.map(c => c.channel).join(", ")}]`);

  if (candidates.length === 0) return "webchat";

  if (explicitChannel && explicitChannel !== "system" && candidates.some((i) => i.channel === explicitChannel)) {
    return explicitChannel;
  }

  if (user?.preferred_cron_channel && user.preferred_cron_channel !== "auto" && candidates.some((i) => i.channel === user.preferred_cron_channel)) {
    return user.preferred_cron_channel;
  }

  for (const preferred of ["telegram", "discord", "slack", "whatsapp", "webchat"]) {
    if (candidates.some((i) => i.channel === preferred)) return preferred;
  }

  return candidates[0].channel;
}

function makeCronDoc(input: {
  id: string;
  name: string;
  task: string;
  task_type: "recurring" | "one_shot";
  cron_expression?: string | null;
  fire_at?: string | null;
  timezone: string;
  payload?: Record<string, unknown>;
  agent_id?: string | null;
  tool_name?: string | null;
  max_runs?: number | null;
  channel?: string;
  start_at?: string | null;
  stop_at?: string | null;
  dom_and_dow?: boolean;
}): CronJobDoc {
  const now = new Date().toISOString();
  return {
    id: input.id,
    name: input.name,
    task: input.task,
    task_type: input.task_type,
    cron_expression: input.cron_expression ?? null,
    fire_at: input.fire_at ?? null,
    timezone: input.timezone,
    start_at: input.start_at ?? null,
    stop_at: input.stop_at ?? null,
    dom_and_dow: !!input.dom_and_dow,
    max_runs: input.max_runs ?? null,
    protect: true,
    interval_sec: null,
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
    next_run_at: input.task_type === "one_shot" ? input.fire_at ?? null : null,
    completed_at: null,
  };
}

async function patchCronJob(id: string, patch: Partial<CronJobDoc>): Promise<boolean> {
  const jobs = await col<CronJobDoc>("cronJobs");
  const entry = await jobs.get(id);
  if (!entry) return false;
  await jobs.put(id, { ...entry.doc, ...patch, updated_at: new Date().toISOString() }, { expectedVersion: entry.version });
  return true;
}

function normalizeChanges(changes: Record<string, unknown>): Partial<CronJobDoc> {
  const patch: Partial<CronJobDoc> = {};
  for (const key of ["name", "task", "cron_expression", "fire_at", "channel", "max_runs", "start_at", "stop_at", "agent_id", "tool_name"] as const) {
    if (changes[key] !== undefined) (patch as any)[key] = changes[key] ?? null;
  }
  if (changes.payload !== undefined) patch.payload = JSON.stringify(changes.payload ?? {});
  if (changes.dom_and_dow !== undefined) patch.dom_and_dow = !!changes.dom_and_dow;
  return patch;
}

export const cronCreateTool: Tool = {
  name: "cron.create",
  description: "Create a new cron job. Use for recurring reminders, daily reports, automated checks. Spanish: crear tarea programada, agendar recordatorio, programar reporte",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short name for the job" },
      task: { type: "string", description: "REQUIRED: Natural language instruction the agent reads when the job triggers" },
      task_type: { type: "string", enum: ["recurring", "one_shot"], description: "Type of scheduled task" },
      cron_expression: { type: "string", description: "Cron expression for recurring tasks" },
      fire_at: { type: "string", description: "ISO 8601 datetime for one_shot tasks" },
      payload: { type: "object", description: "Payload with prompt or message field" },
      agent_id: { type: "string", description: "Target agent ID" },
      tool_name: { type: "string", description: "Specific tool to execute" },
      max_runs: { type: "number", description: "Maximum executions" },
      channel: { type: "string", description: "Notification channel" },
      start_at: { type: "string", description: "Execution window start" },
      stop_at: { type: "string", description: "Execution window end" },
      dom_and_dow: { type: "boolean", description: "Require both day-of-month and day-of-week match" },
    },
    required: ["name", "task", "task_type"],
  },
  execute: async (params: Record<string, unknown>) => {
    const name = params.name as string | undefined;
    const task = params.task as string | undefined;
    const task_type = params.task_type as "recurring" | "one_shot" | undefined;
    const cron_expression = params.cron_expression as string | undefined;
    const fire_at = params.fire_at as string | undefined;

    if (!name) return { ok: false, error: "Missing required field: name" };
    if (!task) return { ok: false, error: "Missing required field: task - provide the instruction the agent should execute" };
    if (!task_type) return { ok: false, error: "Missing required field: task_type (recurring or one_shot)" };
    if (task_type === "recurring" && !cron_expression) return { ok: false, error: "recurring task requires cron_expression" };
    if (task_type === "one_shot" && !fire_at) return { ok: false, error: "one_shot task requires fire_at" };

    if (cron_expression) {
      try {
        Bun.cron(cron_expression, () => {});
      } catch (err) {
        return { ok: false, error: `Invalid cron expression: ${(err as Error).message}` };
      }
    }

    if (fire_at && new Date(fire_at).getTime() <= Date.now()) {
      return { ok: false, error: "fire_at must be in the future" };
    }

    const payload = params.payload as Record<string, unknown> | undefined;
    const payloadObj = payload && !payload._internal ? payload : { prompt: task, ...payload };

    try {
      if (scheduler) {
        const result = await scheduler.create({
          name,
          task,
          task_type,
          cron_expression,
          fire_at,
          timezone: await getUserTimezone(),
          payload: payloadObj,
          agent_id: (params.agent_id as string | undefined) || null,
          tool_name: (params.tool_name as string | undefined) || null,
          max_runs: (params.max_runs as number | undefined) || null,
          channel: (params.channel as string | undefined) || "system",
          start_at: params.start_at as string | undefined,
          stop_at: params.stop_at as string | undefined,
          dom_and_dow: !!params.dom_and_dow,
        });

        return {
          ok: true,
          task_id: result.id,
          next_run: result.nextRun,
          message: `Job "${name}" scheduled. Next run: ${result.nextRun ? new Date(result.nextRun).toLocaleString() : "unknown"}`,
        };
      }

      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await (await col<CronJobDoc>("cronJobs")).put(id, makeCronDoc({
        id,
        name,
        task,
        task_type,
        cron_expression,
        fire_at,
        timezone: await getUserTimezone(),
        payload: payloadObj,
        agent_id: (params.agent_id as string | undefined) || null,
        tool_name: (params.tool_name as string | undefined) || null,
        max_runs: (params.max_runs as number | undefined) || null,
        channel: (params.channel as string | undefined) || "system",
        start_at: (params.start_at as string | undefined) || null,
        stop_at: (params.stop_at as string | undefined) || null,
        dom_and_dow: !!params.dom_and_dow,
      }), { expectedVersion: 0 });

      return { ok: true, task_id: id, message: `Job "${name}" saved (scheduler not active)` };
    } catch (err) {
      log.error(`[create] Failed: ${(err as Error).message}`);
      return { ok: false, error: `Failed to create job: ${(err as Error).message}` };
    }
  },
};

export const cronListTool: Tool = {
  name: "cron.list",
  description: "List all cron jobs with their next execution times and status. Spanish: ver tareas programadas, listar cronograma",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "paused", "completed", "failed", "cancelled"], description: "Filter by status" },
      task_type: { type: "string", enum: ["recurring", "one_shot"], description: "Filter by task type" },
    },
  },
  execute: async (params: Record<string, unknown>) => {
    try {
      const status = params.status as string | undefined;
      const task_type = params.task_type as string | undefined;
      const docs = scheduler
        ? await scheduler.listTasks(status)
        : (await (await col<CronJobDoc>("cronJobs")).scan()).map((entry) => entry.doc).filter((task) => !status || task.status === status);
      const tasks = docs
        .filter((task) => !task_type || task.task_type === task_type)
        .sort((a, b) => String(a.next_run_at ?? "").localeCompare(String(b.next_run_at ?? "")));

      return {
        ok: true,
        tasks: tasks.map((task) => ({
          id: task.id,
          name: task.name,
          task: task.task,
          type: task.task_type,
          status: task.status,
          cron_expression: task.cron_expression,
          fire_at: task.fire_at,
          next_run: task.next_run_at,
          last_run: task.last_run_at,
          run_count: task.run_count,
          channel: task.channel,
        })),
        count: tasks.length,
      };
    } catch (err) {
      log.error(`[list] Failed: ${(err as Error).message}`);
      return { ok: false, error: `Failed to list jobs: ${(err as Error).message}` };
    }
  },
};

export const cronUpdateTool: Tool = {
  name: "cron.update",
  description: "Update an existing cron job: change expression, task instruction, channel, time window, etc. Spanish: actualizar tarea programada, modificar cron, editar recordatorio",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "ID of the job to update" },
      name: { type: "string" },
      task: { type: "string" },
      cron_expression: { type: "string" },
      fire_at: { type: "string" },
      payload: { type: "object" },
      channel: { type: "string" },
      max_runs: { type: "number" },
      start_at: { type: "string" },
      stop_at: { type: "string" },
      dom_and_dow: { type: "boolean" },
      agent_id: { type: "string" },
      tool_name: { type: "string" },
    },
    required: ["task_id"],
  },
  execute: async (params: Record<string, unknown>) => {
    const taskId = params.task_id as string | undefined;
    if (!taskId) return { ok: false, error: "Missing required field: task_id" };

    const changes = { ...params };
    delete changes.task_id;
    if (Object.keys(changes).length === 0) return { ok: false, error: "No fields to update. Provide at least one field besides task_id." };

    try {
      const success = scheduler
        ? await scheduler.update(taskId, changes)
        : await patchCronJob(taskId, normalizeChanges(changes));
      return success
        ? { ok: true, message: `Job "${taskId}" updated` }
        : { ok: false, error: `Job "${taskId}" not found` };
    } catch (err) {
      log.error(`[update] Failed: ${(err as Error).message}`);
      return { ok: false, error: `Failed to update job: ${(err as Error).message}` };
    }
  },
};

export const cronPauseTool: Tool = {
  name: "cron.pause",
  description: "Pause a cron job temporarily without deleting it. Spanish: pausar tarea programada, detener temporalmente",
  parameters: { type: "object", properties: { task_id: { type: "string", description: "ID of the job to pause" } }, required: ["task_id"] },
  execute: async (params: Record<string, unknown>) => {
    const taskId = params.task_id as string | undefined;
    if (!taskId) return { ok: false, error: "Missing required field: task_id" };
    try {
      const success = scheduler ? await scheduler.pause(taskId) : await patchCronJob(taskId, { status: "paused" });
      return success ? { ok: true, message: `Job "${taskId}" paused` } : { ok: false, error: `Job "${taskId}" not found or already paused` };
    } catch (err) {
      log.error(`[pause] Failed: ${(err as Error).message}`);
      return { ok: false, error: `Failed to pause job: ${(err as Error).message}` };
    }
  },
};

export const cronResumeTool: Tool = {
  name: "cron.resume",
  description: "Resume a paused cron job. Spanish: reanudar tarea programada, continuar",
  parameters: { type: "object", properties: { task_id: { type: "string", description: "ID of the job to resume" } }, required: ["task_id"] },
  execute: async (params: Record<string, unknown>) => {
    const taskId = params.task_id as string | undefined;
    if (!taskId) return { ok: false, error: "Missing required field: task_id" };
    try {
      const success = scheduler ? await scheduler.resume(taskId) : await patchCronJob(taskId, { status: "active" });
      return success ? { ok: true, message: `Job "${taskId}" resumed` } : { ok: false, error: `Job "${taskId}" not found or already active` };
    } catch (err) {
      log.error(`[resume] Failed: ${(err as Error).message}`);
      return { ok: false, error: `Failed to resume job: ${(err as Error).message}` };
    }
  },
};

export const cronDeleteTool: Tool = {
  name: "cron.delete",
  description: "Delete a cron job permanently. Spanish: eliminar tarea programada, cancelar recordatorio",
  parameters: { type: "object", properties: { task_id: { type: "string", description: "ID of the job to delete" } }, required: ["task_id"] },
  execute: async (params: Record<string, unknown>) => {
    const taskId = params.task_id as string | undefined;
    if (!taskId) return { ok: false, error: "Missing required field: task_id" };
    try {
      if (scheduler) {
        const success = await scheduler.delete(taskId);
        return success ? { ok: true, message: `Job "${taskId}" deleted` } : { ok: false, error: `Job "${taskId}" not found` };
      }
      const jobs = await col<CronJobDoc>("cronJobs");
      if (!(await jobs.get(taskId))) return { ok: false, error: `Job "${taskId}" not found` };
      await jobs.delete(taskId);
      return { ok: true, message: `Job "${taskId}" deleted` };
    } catch (err) {
      log.error(`[delete] Failed: ${(err as Error).message}`);
      return { ok: false, error: `Failed to delete job: ${(err as Error).message}` };
    }
  },
};

export const cronTriggerTool: Tool = {
  name: "cron.trigger",
  description: "Manually trigger a cron job execution immediately. Spanish: ejecutar tarea ahora, forzar ejecucion",
  parameters: { type: "object", properties: { task_id: { type: "string", description: "ID of the job to trigger" } }, required: ["task_id"] },
  execute: async (params: Record<string, unknown>) => {
    const taskId = params.task_id as string | undefined;
    if (!taskId) return { ok: false, error: "Missing required field: task_id" };
    if (!scheduler) return { ok: false, error: "Scheduler not active - cannot trigger jobs" };
    try {
      const success = await scheduler.trigger(taskId);
      return success ? { ok: true, message: `Job "${taskId}" triggered` } : { ok: false, error: `Job "${taskId}" not found or not active` };
    } catch (err) {
      log.error(`[trigger] Failed: ${(err as Error).message}`);
      return { ok: false, error: `Failed to trigger job: ${(err as Error).message}` };
    }
  },
};

export const cronHistoryTool: Tool = {
  name: "cron.history",
  description: "Get execution history for a cron job. Spanish: historial de ejecuciones, logs de tarea",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "ID of the job" },
      limit: { type: "number", description: "Maximum number of records" },
    },
    required: ["task_id"],
  },
  execute: async (params: Record<string, unknown>) => {
    const taskId = params.task_id as string | undefined;
    const limit = (params.limit as number) || 10;
    if (!taskId) return { ok: false, error: "Missing required field: task_id" };

    try {
      const runs = (await (await col<TaskRunDoc>("taskRuns")).findBy("task_id", taskId))
        .map((entry) => entry.doc)
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, limit);
      return {
        ok: true,
        history: runs.map((run) => ({
          id: run.id,
          status: run.status,
          started_at: run.started_at,
          finished_at: run.finished_at,
          duration_ms: run.duration_ms,
          error_message: run.error_message,
        })),
        count: runs.length,
      };
    } catch (err) {
      log.error(`[history] Failed: ${(err as Error).message}`);
      return { ok: false, error: `Failed to get history: ${(err as Error).message}` };
    }
  },
};

export function createTools(): Tool[] {
  return [
    cronCreateTool,
    cronListTool,
    cronUpdateTool,
    cronPauseTool,
    cronResumeTool,
    cronDeleteTool,
    cronTriggerTool,
    cronHistoryTool,
  ];
}

export const createCronTools = createTools;
