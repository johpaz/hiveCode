/**
 * REST API Endpoints for Cron Jobs.
 */

import type { CronScheduler } from "../../scheduler/CronScheduler"
import { col } from "../../storage/hive"
import type { ChannelDoc, CronJobDoc, TaskRunDoc, UserDoc } from "../../storage/collections"

let _scheduler: CronScheduler | null = null

export function setSchedulerInstance(scheduler: CronScheduler): void {
  _scheduler = scheduler
}

export function getSchedulerInstance(): CronScheduler | null {
  return _scheduler
}

export async function handleGetCronJobs(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response
): Promise<Response> {
  const url = new URL(req.url)
  const status = url.searchParams.get("status") || undefined
  try {
    if (_scheduler) {
      const tasks = await _scheduler.listTasks(status)
      return addCorsHeaders(Response.json({ tasks, count: tasks.length }), req)
    }
    const tasks = (await (await col<CronJobDoc>("cronJobs")).scan())
      .map((entry) => entry.doc)
      .filter((task) => !status || task.status === status)
      .sort((a, b) => String(a.next_run_at ?? "").localeCompare(String(b.next_run_at ?? "")))
    return addCorsHeaders(Response.json({ tasks, count: tasks.length }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to list tasks: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handleGetCronJob(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  taskId: string
): Promise<Response> {
  try {
    const task = _scheduler ? await _scheduler.getTask(taskId) : (await (await col<CronJobDoc>("cronJobs")).get(taskId))?.doc
    if (!task) return addCorsHeaders(Response.json({ error: "Task not found" }, { status: 404 }), req)
    return addCorsHeaders(Response.json({ task }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to get task: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handleCreateCronJob(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response
): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}))
    const { name, task, task_type, cron_expression, fire_at, payload, agent_id, tool_name, max_runs, channel, start_at, stop_at, dom_and_dow, protect, interval_sec } = body
    if (!name || !task_type || !task) {
      return addCorsHeaders(Response.json({ error: "Missing required fields: name, task, task_type" }, { status: 400 }), req)
    }

    const user = (await (await col<UserDoc>("users")).scan()).map((entry) => entry.doc)[0]
    const timezone = user?.timezone || "UTC"
    if (_scheduler) {
      const result = await _scheduler.create({
        name,
        task,
        task_type,
        cron_expression,
        fire_at,
        timezone,
        payload: payload || { prompt: task },
        agent_id: agent_id || null,
        tool_name: tool_name || null,
        max_runs: max_runs || null,
        channel: channel || "system",
        start_at: start_at || undefined,
        stop_at: stop_at || undefined,
        dom_and_dow: dom_and_dow || false,
        protect: protect !== false,
        interval_sec: interval_sec || null,
      })
      return addCorsHeaders(Response.json({ ok: true, task_id: result.id, next_run: result.nextRun }), req)
    }

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    const now = new Date().toISOString()
    const doc: CronJobDoc = {
      id,
      name,
      task,
      task_type,
      cron_expression: cron_expression || null,
      fire_at: fire_at || null,
      timezone,
      start_at: start_at || null,
      stop_at: stop_at || null,
      dom_and_dow: !!dom_and_dow,
      max_runs: max_runs || null,
      protect: protect !== false,
      interval_sec: interval_sec || null,
      agent_id: agent_id || "",
      channel: channel || "system",
      payload: JSON.stringify(payload || {}),
      tool_name: tool_name || null,
      status: "active",
      run_count: 0,
      error_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
      last_run_at: null,
      next_run_at: null,
      completed_at: null,
    }
    await (await col<CronJobDoc>("cronJobs")).put(id, doc)
    return addCorsHeaders(Response.json({ ok: true, task_id: id }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to create job: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handleUpdateCronJob(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  taskId: string
): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}))
    if (_scheduler) {
      const success = await _scheduler.update(taskId, body)
      return success
        ? addCorsHeaders(Response.json({ ok: true }), req)
        : addCorsHeaders(Response.json({ error: "Job not found" }, { status: 404 }), req)
    }
    const updated = await patchCronJob(taskId, normalizeCronPatch(body))
    return updated
      ? addCorsHeaders(Response.json({ ok: true }), req)
      : addCorsHeaders(Response.json({ error: "Task not found" }, { status: 404 }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to update task: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handleDeleteCronJob(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  taskId: string
): Promise<Response> {
  try {
    if (_scheduler) {
      const success = await _scheduler.delete(taskId)
      return success
        ? addCorsHeaders(Response.json({ ok: true }), req)
        : addCorsHeaders(Response.json({ error: "Task not found" }, { status: 404 }), req)
    }
    const jobs = await col<CronJobDoc>("cronJobs")
    if (!(await jobs.get(taskId))) return addCorsHeaders(Response.json({ error: "Task not found" }, { status: 404 }), req)
    await jobs.delete(taskId)
    return addCorsHeaders(Response.json({ ok: true }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to delete task: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handlePauseCronJob(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  taskId: string
): Promise<Response> {
  try {
    const success = _scheduler ? await _scheduler.pause(taskId) : await patchCronJob(taskId, { status: "paused" })
    return success
      ? addCorsHeaders(Response.json({ ok: true, message: `Task "${taskId}" paused` }), req)
      : addCorsHeaders(Response.json({ error: "Task not found or already paused" }, { status: 404 }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to pause task: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handleResumeCronJob(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  taskId: string
): Promise<Response> {
  try {
    const success = _scheduler ? await _scheduler.resume(taskId) : await patchCronJob(taskId, { status: "active" })
    return success
      ? addCorsHeaders(Response.json({ ok: true, message: `Task "${taskId}" resumed` }), req)
      : addCorsHeaders(Response.json({ error: "Task not found or already active" }, { status: 404 }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to resume task: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handleTriggerCronJob(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  taskId: string
): Promise<Response> {
  try {
    if (!_scheduler) return addCorsHeaders(Response.json({ error: "Scheduler not active" }, { status: 503 }), req)
    const success = await _scheduler.trigger(taskId)
    return success
      ? addCorsHeaders(Response.json({ ok: true, message: `Task "${taskId}" triggered` }), req)
      : addCorsHeaders(Response.json({ error: "Task not found or not active" }, { status: 404 }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to trigger task: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handleGetCronJobHistory(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  taskId: string
): Promise<Response> {
  try {
    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get("limit") || "10", 10)
    const runs = (await (await col<TaskRunDoc>("taskRuns")).findBy("task_id", taskId))
      .map((entry) => entry.doc)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit)
    return addCorsHeaders(Response.json({ history: runs, count: runs.length }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to get history: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handleGetCronStatus(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response
): Promise<Response> {
  try {
    if (_scheduler) return addCorsHeaders(Response.json({ status: await _scheduler.getStatus() }), req)
    return addCorsHeaders(Response.json({ status: [], message: "Scheduler not active" }), req)
  } catch (err) {
    return addCorsHeaders(Response.json({ error: `Failed to get status: ${(err as Error).message}` }, { status: 500 }), req)
  }
}

export async function handleGetCronChannels(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response
): Promise<Response> {
  try {
    const recommended = ["telegram", "discord", "slack", "whatsapp", "webchat"]
    const channels = (await (await col<ChannelDoc>("channels")).scan())
      .map((entry) => entry.doc)
      .filter((channel) => channel.active)
      .map((ch) => ({
        id: ch.id,
        type: ch.type || ch.id,
        active: ch.active,
        recommended: recommended.includes(ch.type || ch.id),
      }))
    if (channels.length === 0) channels.push({ id: "webchat", type: "webchat", active: true, recommended: true })
    return addCorsHeaders(Response.json({ channels }), req)
  } catch {
    return addCorsHeaders(Response.json({ channels: [{ id: "webchat", type: "webchat", active: true, recommended: true }] }), req)
  }
}

function normalizeCronPatch(body: Record<string, any>): Partial<CronJobDoc> {
  const patch: Partial<CronJobDoc> = {}
  for (const key of ["name", "task", "cron_expression", "fire_at", "start_at", "stop_at", "status", "max_runs"] as const) {
    if (body[key] !== undefined) (patch as any)[key] = body[key]
  }
  if (body.dom_and_dow !== undefined) patch.dom_and_dow = !!body.dom_and_dow
  if (body.payload !== undefined) patch.payload = JSON.stringify(body.payload)
  patch.updated_at = new Date().toISOString()
  return patch
}

async function patchCronJob(taskId: string, patch: Partial<CronJobDoc>): Promise<boolean> {
  const jobs = await col<CronJobDoc>("cronJobs")
  const entry = await jobs.get(taskId)
  if (!entry) return false
  await jobs.put(taskId, { ...entry.doc, ...patch }, { expectedVersion: entry.version })
  return true
}
