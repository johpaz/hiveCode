import { col } from "../../storage/hive"
import type { AgentDoc, UserDoc } from "../../storage/collections"

export async function handleGetUsers(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const agents = (await (await col<AgentDoc>("agents")).scan()).map((entry) => entry.doc)
  const users = (await (await col<UserDoc>("users")).scan())
    .map((entry) => entry.doc)
    .sort((a, b) => b.created_at - a.created_at)

  return addCorsHeaders(Response.json({
    users: users.map(u => ({
      id: u.id,
      name: u.name,
      language: u.language,
      timezone: u.timezone,
      occupation: u.occupation,
      notes: u.notes,
      createdAt: new Date(u.created_at).toISOString(),
      agentCount: agents.filter((agent) => agent.user_id === u.id).length,
    }))
  }), req)
}

export async function handleCreateUser(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const id = body.id || crypto.randomUUID()
  const user: UserDoc = {
    id,
    name: body.name || "User",
    language: body.language || "es",
    timezone: body.timezone || "UTC",
    occupation: body.occupation || "",
    notes: body.notes || "",
    master_key_hash: null,
    email: body.email || null,
    password_hash: body.password_hash || null,
    preferred_cron_channel: body.preferred_cron_channel || "webchat",
    created_at: Date.now(),
  }
  await (await col<UserDoc>("users")).put(id, user)
  return addCorsHeaders(Response.json({ ok: true, userId: id }), req)
}

export async function handleUpdateUserSettings(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const userId = url.searchParams.get("userId") || "default"
  const body = await req.json().catch(() => ({}))
  const users = await col<UserDoc>("users")
  const existing = await users.get(userId)
  if (!existing) return addCorsHeaders(Response.json({ ok: false, error: "User not found" }, { status: 404 }), req)

  const patch: Partial<UserDoc> = {}
  for (const key of ["name", "language", "timezone", "occupation", "notes", "preferred_cron_channel"] as const) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  await users.put(userId, { ...existing.doc, ...patch }, { expectedVersion: existing.version })
  return addCorsHeaders(Response.json({ ok: true }), req)
}

export async function handleGetUserChannels(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  config?: any
): Promise<Response> {
  return addCorsHeaders(Response.json({
    user: config?.user || { id: "", name: "User", channels: {} },
  }), req)
}

export async function handleLinkUserChannel(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  config?: any,
  logger?: any
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { channel, channelUserId } = body

  if (!channel || !channelUserId) {
    return addCorsHeaders(Response.json({ success: false, error: "Missing channel or channelUserId" }, { status: 400 }), req)
  }

  if (config) {
    config.user = config.user || { id: "", name: "User" }
    config.user.channels = config.user.channels || {}
    config.user.channels[channel] = channelUserId
    logger?.info(`Linked channel ${channel} to user ID ${channelUserId}`)
  }

  return addCorsHeaders(Response.json({ success: true, channels: config?.user?.channels }), req)
}
