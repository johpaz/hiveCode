import { encryptConfig, decryptConfig } from "../../storage/crypto"
import { col } from "../../storage/hive"
import type { ChannelDoc, UserChannelDoc } from "../../storage/collections"

type ConnectedChannel = {
  id: string;
  type: string;
  accountId?: string;
  enabled: boolean;
  active: boolean;
  status: string;
  last_active?: number;
  voice_enabled: boolean;
  tts_enabled: boolean;
  stt_provider?: string;
  tts_provider?: string;
  tts_voice_id?: string;
  step_delivery_mode?: string;
  vision_enabled: boolean;
  ocr_provider?: string;
  vision_provider?: string;
  vision_model_id?: string;
  isConfigured?: boolean;
}

export async function handleGetChannels(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  channelManager?: any
): Promise<Response> {
  const userConfigs = await col<UserChannelDoc>("userChannels")
  const channels = (await (await col<ChannelDoc>("channels")).scan()).map((entry) => entry.doc)
  const formattedChannels: ConnectedChannel[] = []

  for (const c of channels) {
    let liveStatus = c.status
    if (channelManager && typeof channelManager.getChannelStatus === "function") {
      const live = channelManager.getChannelStatus(c.type, c.id)
      if (live && live.status !== "not_found") liveStatus = live.status
    }
    const configured = (await userConfigs.findBy("channel", c.type)).some((entry) => entry.doc.account_id === c.id)
    formattedChannels.push({
      id: c.id,
      type: c.type,
      accountId: c.id,
      enabled: c.enabled,
      active: c.active,
      status: liveStatus,
      last_active: c.last_active ?? undefined,
      voice_enabled: c.voice_enabled,
      tts_enabled: c.tts_enabled,
      stt_provider: c.stt_provider ?? undefined,
      tts_provider: c.tts_provider ?? undefined,
      tts_voice_id: c.tts_voice_id ?? undefined,
      step_delivery_mode: c.step_delivery_mode ?? undefined,
      vision_enabled: c.vision_enabled,
      ocr_provider: c.ocr_provider ?? undefined,
      vision_provider: c.vision_provider ?? undefined,
      vision_model_id: c.vision_model_id ?? undefined,
      isConfigured: configured,
    })
  }

  return addCorsHeaders(Response.json({ channels: formattedChannels }), req)
}

export async function handleGetChannelConfig(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const channelIdMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/)
  if (!channelIdMatch) return addCorsHeaders(Response.json({ error: "Invalid path" }), req)

  const channelId = channelIdMatch[1]
  const config = (await (await col<UserChannelDoc>("userChannels")).findBy("channel", channelId)).map((entry) => entry.doc)
  return addCorsHeaders(Response.json({ config }), req)
}

export async function handleActivateChannel(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { channel, config, accountId } = body
  if (!channel) return addCorsHeaders(Response.json({ success: false, error: "channel required" }), req)

  await putUserChannel("default", channel, accountId || channel, config || {}, true)
  return addCorsHeaders(Response.json({ success: true, channel }), req)
}

export async function handleDeactivateChannel(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split("/")
  const channel = parts[3]
  const accountId = parts[4]
  if (!channel) return addCorsHeaders(Response.json({ success: false, error: "channel required" }), req)

  const configs = await col<UserChannelDoc>("userChannels")
  for (const entry of await configs.findBy("channel", channel)) {
    if (entry.doc.user_id === "default" && (!accountId || entry.doc.account_id === accountId)) {
      await configs.delete(entry.id)
    }
  }
  return addCorsHeaders(Response.json({ success: true }), req)
}

export async function handleCreateChannel(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  channelManager?: any
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { type, config: channelConfig } = body
  if (!type) return addCorsHeaders(new Response("Missing type", { status: 400 }), req)

  const channels = await col<ChannelDoc>("channels")
  const seeded = (await channels.findBy("type", type)).find((entry) => entry.doc.status === "disconnected" || entry.doc.status === "idle")
  const id = seeded?.id ?? crypto.randomUUID()
  const doc = channelDoc(id, type, { enabled: true, active: true, status: "connecting" })
  await channels.put(id, seeded ? { ...seeded.doc, ...doc } : doc, { expectedVersion: seeded?.version ?? 0 })
  await putUserChannel("default", type, id, channelConfig || {}, true)

  if (channelManager) {
    channelManager.addChannel(type, id, channelConfig || {}).catch((err: Error) => {
      console.error(`[channels] Failed to start ${type}:${id}:`, err.message)
    })
  }
  return addCorsHeaders(Response.json({ success: true, id, status: "connecting" }), req)
}

export async function handleReconnectChannel(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  channelId: string,
  channelManager?: any
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { config: newConfig } = body
  const channels = await col<ChannelDoc>("channels")
  const row = await channels.get(channelId)
  if (!row) return addCorsHeaders(Response.json({ success: false, error: "Channel not found" }, { status: 404 }), req)

  await channels.put(channelId, { ...row.doc, enabled: true, active: true, status: "connecting" }, { expectedVersion: row.version })
  const config = newConfig && Object.keys(newConfig).length > 0 ? newConfig : await getStoredChannelConfig(row.doc.type, channelId)
  if (newConfig && Object.keys(newConfig).length > 0) await putUserChannel("default", row.doc.type, channelId, newConfig, true)

  if (channelManager) {
    ;(async () => {
      try { await channelManager.removeChannel(row.doc.type, channelId) } catch { /* ignore */ }
      try { await channelManager.addChannel(row.doc.type, channelId, config) } catch (err: unknown) {
        console.error(`[channels] Failed to reconnect ${row.doc.type}:${channelId}:`, (err as Error).message)
      }
    })()
  }

  return addCorsHeaders(Response.json({ success: true, status: "connecting" }), req)
}

export async function handleGetChannelStatus(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  channelManager?: any
): Promise<Response> {
  const url = new URL(req.url)
  const match = url.pathname.match(/^\/api\/channels\/([^/]+)\/([^/]+)\/status$/)
  if (!match) return addCorsHeaders(Response.json({ error: "Invalid path" }, { status: 400 }), req)
  const [, type, id] = match
  if (!channelManager) return addCorsHeaders(Response.json({ status: "unknown" }), req)
  return addCorsHeaders(Response.json(channelManager.getChannelStatus(type, id)), req)
}

export async function handleGetChannelAccount(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  name: string,
  accountId: string
): Promise<Response> {
  return addCorsHeaders(Response.json({ name, accountId, config: await getStoredChannelConfig(name, accountId) }), req)
}

export async function handleUpdateChannelAccount(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  name: string,
  accountId: string,
  channelManager?: any
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  if (!body.config) return new Response("Missing config", { status: 400 })
  await putUserChannel("default", name, accountId, body.config, true)
  if (channelManager) {
    await channelManager.removeChannel(name, accountId)
    await channelManager.startChannel(name, accountId)
  }
  return addCorsHeaders(Response.json({ success: true }), req)
}

export async function handleDeleteChannelAccount(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  name: string,
  accountId: string,
  _config?: any,
  channelManager?: any
): Promise<Response> {
  await deleteUserChannel("default", name, accountId)
  if (channelManager) await channelManager.removeChannel(name, accountId)
  return addCorsHeaders(Response.json({ success: true }), req)
}

export async function handleChannelAction(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  name: string,
  accountId: string,
  action: "start" | "stop",
  channelManager?: any
): Promise<Response> {
  try {
    if (!channelManager) return addCorsHeaders(new Response("Channel manager not available", { status: 500 }), req)
    if (action === "start") await channelManager.startChannel(name, accountId)
    else await channelManager.stopChannel(name, accountId)
    return addCorsHeaders(Response.json({ success: true }), req)
  } catch (error) {
    return addCorsHeaders(Response.json({ success: false, error: (error as Error).message }, { status: 500 }), req)
  }
}

export async function handleUpdateChannelSettings(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  channelId: string
): Promise<Response> {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const channels = await col<ChannelDoc>("channels")
  const row = await channels.get(channelId)
  if (!row) return addCorsHeaders(Response.json({ success: false, error: "Channel not found" }, { status: 404 }), req)

  const patch: Partial<ChannelDoc> = {}
  for (const key of ["voice_enabled", "tts_enabled", "stt_provider", "tts_provider", "tts_voice_id", "step_delivery_mode", "vision_enabled", "ocr_provider", "vision_provider", "vision_model_id"] as const) {
    if (key in body) (patch as any)[key] = body[key]
  }
  if (body.config && typeof body.config === "object") {
    const current = await getStoredChannelConfig(row.doc.type, channelId)
    await putUserChannel("default", row.doc.type, channelId, { ...current, ...(body.config as Record<string, unknown>) }, true)
  }
  if (Object.keys(patch).length === 0 && !body.config) {
    return addCorsHeaders(Response.json({ error: "No valid fields to update" }, { status: 400 }), req)
  }
  await channels.put(channelId, { ...row.doc, ...patch }, { expectedVersion: row.version })
  return addCorsHeaders(Response.json({ success: true }), req)
}

export async function handleToggleChannel(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  channelId: string
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { active } = body
  if (active === undefined) {
    return addCorsHeaders(Response.json({ success: false, error: "Missing active field", message: "Falta el campo 'active'" }, { status: 400 }), req)
  }
  const channels = await col<ChannelDoc>("channels")
  const row = await channels.get(channelId)
  if (row) await channels.put(channelId, { ...row.doc, active: !!active, enabled: !!active }, { expectedVersion: row.version })
  return addCorsHeaders(Response.json({ success: true, active, message: active ? `Canal "${channelId}" activado` : `Canal "${channelId}" desactivado` }), req)
}

export async function handleGetWhatsAppDetails(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  channelId: string,
  channelManager?: any
): Promise<Response> {
  if (!channelManager) return addCorsHeaders(Response.json({ error: "Channel manager not available", status: 500 }), req)
  const details = channelManager.getWhatsAppDetails(channelId)
  if (!details) return addCorsHeaders(Response.json({ error: "WhatsApp channel not found", status: 404 }), req)
  return addCorsHeaders(Response.json(details), req)
}

export async function handleDisconnectWhatsApp(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  channelId: string,
  channelManager?: any
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { clearSession } = body
  if (!channelManager) return addCorsHeaders(Response.json({ success: false, error: "Channel manager not available", status: 500 }), req)
  const channel = channelManager.channels?.get?.(`whatsapp:${channelId}`)
  if (!channel) return addCorsHeaders(Response.json({ success: false, error: "WhatsApp channel not found", status: 404 }), req)

  try {
    if (typeof (channel as any).disconnect === "function") await (channel as any).disconnect(clearSession === true)
    return addCorsHeaders(Response.json({ success: true }), req)
  } catch (error) {
    return addCorsHeaders(Response.json({ success: false, error: (error as Error).message }, { status: 500 }), req)
  }
}

export async function handleUpdateWhatsAppConfig(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  channelId: string,
  channelManager?: any
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const currentConfig = await getStoredChannelConfig("whatsapp", channelId)
  const merged: Record<string, unknown> = { ...currentConfig }
  for (const key of ["acceptGroups", "reconnectMaxAttempts", "reconnectBaseDelayMs", "dmPolicy", "selfMessagesOnly", "allowFrom"]) {
    if (body[key] !== undefined) merged[key] = key === "allowFrom" ? (Array.isArray(body[key]) ? body[key] : []) : body[key]
  }
  await putUserChannel("default", "whatsapp", channelId, merged, true)

  if (channelManager) {
    try {
      await channelManager.removeChannel("whatsapp", channelId)
      await channelManager.addChannel("whatsapp", channelId, merged)
    } catch { /* ignore restart errors */ }
  }
  return addCorsHeaders(Response.json({ success: true }), req)
}

function channelDoc(id: string, type: string, patch: Partial<ChannelDoc> = {}): ChannelDoc {
  return {
    id,
    user_id: "default",
    type,
    enabled: false,
    active: false,
    status: "disconnected",
    last_active: null,
    voice_enabled: false,
    tts_enabled: false,
    stt_provider: null,
    tts_provider: null,
    tts_voice_id: null,
    step_delivery_mode: "summary",
    vision_enabled: false,
    ocr_provider: null,
    vision_provider: null,
    vision_model_id: null,
    ...patch,
  }
}

function configDocId(userId: string, channel: string, accountId: string): string {
  return `${userId}:${channel}:${accountId}`
}

async function putUserChannel(userId: string, channel: string, accountId: string, config: Record<string, unknown>, active: boolean): Promise<void> {
  const userChannels = await col<UserChannelDoc>("userChannels")
  const id = configDocId(userId, channel, accountId)
  const existing = await userChannels.get(id)
  const encrypted = encryptConfig(config || {})
  await userChannels.put(id, {
    id,
    user_id: userId,
    channel,
    account_id: accountId,
    config: JSON.stringify(encrypted),
    active,
    created_at: existing?.doc.created_at ?? Date.now(),
    updated_at: Date.now(),
  }, { expectedVersion: existing?.version ?? 0 })
}

async function deleteUserChannel(userId: string, channel: string, accountId: string): Promise<void> {
  await (await col<UserChannelDoc>("userChannels")).delete(configDocId(userId, channel, accountId))
}

async function getStoredChannelConfig(channel: string, accountId: string): Promise<Record<string, unknown>> {
  const entry = await (await col<UserChannelDoc>("userChannels")).get(configDocId("default", channel, accountId))
  if (!entry) return {}
  try {
    const encrypted = JSON.parse(entry.doc.config) as { encrypted: string; iv: string }
    return decryptConfig(encrypted.encrypted, encrypted.iv)
  } catch {
    try { return JSON.parse(entry.doc.config) } catch { return {} }
  }
}
