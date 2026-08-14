import { encryptConfig, decryptConfig } from "../../storage/crypto.ts"
import { col } from "../../storage/hive"
import type { McpServerDoc } from "../../storage/collections"
import { logger } from "../../utils/logger.ts"

const mcpLog = logger.child("mcp:api")

export async function handleGetMcpServers(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  mcpManager?: any
): Promise<Response> {
  const liveServers = new Map<string, { status: string; tools: any[] }>()
  if (mcpManager) {
    try {
      const servers = mcpManager.listServers?.() || []
      for (const s of servers) liveServers.set(s.name, { status: s.status, tools: s.tools || [] })
    } catch (e) {
      mcpLog.warn(`Failed to get MCP servers: ${(e as Error).message}`)
    }
  }

  const docs = (await (await col<McpServerDoc>("mcpServers")).scan())
    .map((entry) => entry.doc)
    .sort((a, b) => a.name.localeCompare(b.name))

  const allServers = docs.map(s => {
    const normalizedName = s.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
    const live = liveServers.get(s.name) || liveServers.get(normalizedName)
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      status: live?.status || s.status || "disconnected",
      config: {
        transport: s.transport,
        command: s.command,
        args: s.args ? JSON.parse(s.args) : [],
        url: s.url,
        headers: redactHeaders(s),
        enabled: s.enabled,
      },
      tools_count: live?.tools.length || s.tools_count || 0,
      tools: live?.tools || [],
    }
  })

  return addCorsHeaders(Response.json(allServers), req)
}

export async function handleCreateMcpServer(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  if (!body.name || !body.config) {
    return addCorsHeaders(new Response("Missing name or config", { status: 400 }), req)
  }

  const serverId = body.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
  const headers = body.config.headers ? encryptConfig(body.config.headers) : null
  const doc: McpServerDoc = {
    id: serverId,
    name: body.name,
    transport: body.config.transport || "stdio",
    command: body.config.command || null,
    args: body.config.args ? JSON.stringify(body.config.args) : null,
    env_encrypted: null,
    env_iv: null,
    headers_encrypted: headers?.encrypted ?? null,
    headers_iv: headers?.iv ?? null,
    url: body.config.url || null,
    enabled: body.config.enabled !== false,
    active: body.config.enabled !== false,
    builtin: false,
    status: "disconnected",
    tools_count: 0,
    user_id: body.user_id,
  }
  await (await col<McpServerDoc>("mcpServers")).put(serverId, doc)
  return addCorsHeaders(Response.json({ success: true, id: serverId }), req)
}

export async function handleDeleteMcpServer(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split("/").filter(Boolean)
  const serverName = parts[parts.length - 1]

  if (!serverName || serverName === "servers") {
    return addCorsHeaders(Response.json({ success: false, error: "server name required" }), req)
  }

  const entry = await findServer(serverName)
  if (entry) await (await col<McpServerDoc>("mcpServers")).delete(entry.id)
  return addCorsHeaders(Response.json({ success: true }), req)
}

export async function handleGetMcpServerDetail(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  serverId: string
): Promise<Response> {
  const entry = await findServer(serverId)
  const server = entry?.doc
  if (!server) return addCorsHeaders(new Response("Server not found", { status: 404 }), req)

  return addCorsHeaders(Response.json({
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ? JSON.parse(server.args) : [],
    url: server.url ?? null,
    headers: readHeaders(server),
    enabled: server.enabled,
    builtin: server.builtin,
    status: server.status,
    tools_count: server.tools_count ?? 0,
  }), req)
}

export async function handleUpdateMcpServer(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split("/").filter(Boolean)
  const serverName = parts[parts.length - 1]
  const body = await req.json().catch(() => ({}))

  if (!serverName || serverName === "servers") {
    return addCorsHeaders(new Response("Missing server name", { status: 400 }), req)
  }

  const servers = await col<McpServerDoc>("mcpServers")
  const entry = await findServer(serverName)
  if (!entry) return addCorsHeaders(new Response("Server not found", { status: 404 }), req)

  const patch: Partial<McpServerDoc> = {}
  if (body.transport !== undefined) patch.transport = body.transport
  if (body.name !== undefined) patch.name = body.name
  if (body.command !== undefined) patch.command = body.command
  if (body.args !== undefined) patch.args = JSON.stringify(body.args)
  if (body.url !== undefined) patch.url = body.url
  if (body.enabled !== undefined) {
    patch.enabled = !!body.enabled
    patch.active = !!body.enabled
  }
  if (body.headers) {
    const { encrypted, iv } = encryptConfig(body.headers)
    patch.headers_encrypted = encrypted
    patch.headers_iv = iv
  }

  await servers.put(entry.id, { ...entry.doc, ...patch }, { expectedVersion: entry.version })
  return addCorsHeaders(Response.json({ success: true }), req)
}

export async function handleStartMcpServer(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const serverId = url.pathname.split("/").pop()
  if (!serverId) return addCorsHeaders(Response.json({ success: false, error: "serverId required" }), req)

  await patchServer(serverId, { enabled: true, active: true })
  return addCorsHeaders(Response.json({ success: true, serverId, enabled: true }), req)
}

export async function handleGetMcpServerTools(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  serverName: string,
  mcpManager?: any
): Promise<Response> {
  if (!mcpManager) return addCorsHeaders(Response.json([]), req)
  return addCorsHeaders(Response.json(mcpManager.getServerTools(serverName)), req)
}

export async function handleToggleMcpServer(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  mcpId: string
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { active } = body
  if (active === undefined) {
    return addCorsHeaders(Response.json({ success: false, error: "Missing active field", message: "Falta el campo 'active'" }, { status: 400 }), req)
  }

  await patchServer(mcpId, { active: !!active, enabled: !!active })
  return addCorsHeaders(Response.json({ success: true, active, message: active ? "Servidor MCP activado" : "Servidor MCP desactivado" }), req)
}

export async function handleMcpServerAction(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  serverName: string,
  action: "connect" | "disconnect",
  mcpManager?: any
): Promise<Response> {
  if (!mcpManager) return addCorsHeaders(new Response("MCP is disabled", { status: 404 }), req)

  if (action === "connect") {
    const entry = await findServer(serverName)
    if (!entry?.doc.enabled) return new Response("Server not found or disabled", { status: 400 })

    await mcpManager.connectServer(serverName)
    const tools = mcpManager.getServerTools(serverName) || []
    await patchServer(serverName, { status: "connected", tools_count: tools.length })
    return addCorsHeaders(Response.json({ success: true, tools_count: tools.length }), req)
  }

  if (action === "disconnect") {
    await mcpManager.disconnectServer(serverName)
    await patchServer(serverName, { status: "disconnected", tools_count: 0 })
    return addCorsHeaders(Response.json({ success: true }), req)
  }

  return addCorsHeaders(new Response("Invalid action", { status: 400 }), req)
}

export async function handleGetMCPServerTools(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  serverId: string,
  mcpManager?: any
): Promise<Response> {
  if (!mcpManager) return addCorsHeaders(new Response("MCP is disabled", { status: 404 }), req)
  const tools = mcpManager.getServerTools(serverId) || []
  return addCorsHeaders(Response.json({ tools }), req)
}

async function findServer(idOrName: string) {
  const servers = await col<McpServerDoc>("mcpServers")
  const byId = await servers.get(idOrName)
  if (byId) return byId
  return (await servers.scan()).find((entry) => entry.doc.name === idOrName)
}

async function patchServer(idOrName: string, patch: Partial<McpServerDoc>): Promise<void> {
  const servers = await col<McpServerDoc>("mcpServers")
  const entry = await findServer(idOrName)
  if (!entry) return
  await servers.put(entry.id, { ...entry.doc, ...patch }, { expectedVersion: entry.version })
}

function readHeaders(server: McpServerDoc): Record<string, string> | undefined {
  if (!server.headers_encrypted || !server.headers_iv) return undefined
  try {
    return decryptConfig(server.headers_encrypted, server.headers_iv) as Record<string, string>
  } catch (e) {
    mcpLog.error(`Failed to decrypt headers for ${server.name}: ${(e as Error).message}`)
    return undefined
  }
}

function redactHeaders(server: McpServerDoc): Record<string, string> | undefined {
  const headers = readHeaders(server)
  if (!headers) return undefined
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [
    k,
    k.toLowerCase().includes("auth") || k.toLowerCase().includes("token") || k.toLowerCase().includes("key")
      ? `${String(v).slice(0, 4)}••••••••`
      : v,
  ]))
}
