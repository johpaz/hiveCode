import { col } from "../../storage/hive"
import type { TaskDoc } from "../../storage/collections"

export async function handleGetTasks(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.searchParams.get("agentId")
  const tasks = agentId
    ? (await (await col<TaskDoc>("tasks")).findBy("agent_id", agentId)).map((entry) => entry.doc)
    : (await (await col<TaskDoc>("tasks")).scan()).map((entry) => entry.doc)

  tasks.sort((a, b) => a.id.localeCompare(b.id))
  return addCorsHeaders(Response.json({ tasks }), req)
}

export async function handleUpdateTask(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split("/").pop()
  const body = await req.json().catch(() => ({}))

  if (!taskId) {
    return addCorsHeaders(new Response("Missing ID", { status: 400 }), req)
  }

  const tasks = await col<TaskDoc>("tasks")
  const existing = await tasks.get(taskId)
  if (!existing) return addCorsHeaders(Response.json({ ok: false, error: "Task not found" }, { status: 404 }), req)

  const patch: Partial<TaskDoc> = {}
  if (body.status !== undefined) patch.status = body.status
  if (body.result !== undefined) patch.result = body.result
  await tasks.put(taskId, { ...existing.doc, ...patch, updated_at: Date.now() }, { expectedVersion: existing.version })

  return addCorsHeaders(Response.json({ ok: true }), req)
}
