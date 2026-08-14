import { col } from "../../storage/hive"
import type { EthicsDoc } from "../../storage/collections"

export async function handleGetEthics(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const ethics = (await (await col<EthicsDoc>("ethics")).scan())
    .map((entry) => entry.doc)
    .sort((a, b) => a.name.localeCompare(b.name))

  return addCorsHeaders(Response.json({
    ethics: ethics.map(e => ({
      id: e.id,
      name: e.name,
      description: e.description,
      content: e.content,
      active: e.active,
      enabled: e.enabled,
    }))
  }), req)
}

export async function handleActivateEthics(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { ethicsId, active } = body

  if (!ethicsId) {
    return addCorsHeaders(Response.json({ success: false, error: "ethicsId required" }), req)
  }

  const ethics = await col<EthicsDoc>("ethics")
  const existing = await ethics.get(ethicsId)
  if (existing) {
    await ethics.put(ethicsId, { ...existing.doc, active: !!active, enabled: !!active }, { expectedVersion: existing.version })
  }

  return addCorsHeaders(Response.json({ success: true, ethicsId, active }), req)
}

export async function handleDeleteEthics(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const id = url.pathname.split("/").pop()

  if (!id) {
    return addCorsHeaders(Response.json({ success: false, error: "id required" }), req)
  }

  await (await col<EthicsDoc>("ethics")).delete(id)
  return addCorsHeaders(Response.json({ success: true }), req)
}
