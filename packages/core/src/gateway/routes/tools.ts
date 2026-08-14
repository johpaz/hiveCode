import { col } from "../../storage/hive"
import type { ToolDoc } from "../../storage/collections"

export async function handleGetTools(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const tools = (await (await col<ToolDoc>("tools")).scan())
    .map((entry) => entry.doc)
    .sort((a, b) => a.name.localeCompare(b.name))

  return addCorsHeaders(Response.json({
    tools: tools.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      active: t.active,
      enabled: t.enabled,
    }))
  }), req)
}

export async function handleActivateTool(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const toolId = url.pathname.split("/")[3]
  const body = await req.json().catch(() => ({}))
  const { active } = body

  if (!toolId) {
    return addCorsHeaders(Response.json({ success: false, error: "toolId required" }), req)
  }

  const tools = await col<ToolDoc>("tools")
  const existing = await tools.get(toolId)
  if (existing) {
    await tools.put(toolId, { ...existing.doc, active: !!active, enabled: !!active, updated_at: Date.now() }, { expectedVersion: existing.version })
  }

  return addCorsHeaders(Response.json({ success: true, toolId, active }), req)
}

export async function handleUpdateTool(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const toolId = url.pathname.split("/")[3]
  const body = await req.json().catch(() => ({}))

  if (!toolId) {
    return addCorsHeaders(Response.json({ success: false, error: "toolId required" }), req)
  }

  const tools = await col<ToolDoc>("tools")
  const existing = await tools.get(toolId)
  if (!existing) return addCorsHeaders(Response.json({ success: false, error: "Tool not found" }, { status: 404 }), req)

  const patch: Partial<ToolDoc> = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.description !== undefined) patch.description = body.description
  if (body.category !== undefined) patch.category = body.category

  await tools.put(toolId, { ...existing.doc, ...patch, updated_at: Date.now() }, { expectedVersion: existing.version })
  return addCorsHeaders(Response.json({ success: true }), req)
}
