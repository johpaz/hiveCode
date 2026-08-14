import { col } from "../storage/hive"
import type { AgentDoc, UserDoc, UserIdentityDoc } from "../storage/collections"

export interface ResolveContextResult {
  userId: string
  agentId: string
  isNewUser: boolean
}

export interface ResolveContextOptions {
  channel: string
  channelUserId: string
}

export async function resolveContext(options: ResolveContextOptions): Promise<ResolveContextResult> {
  const { channel, channelUserId } = options
  const identities = await col<UserIdentityDoc>("userIdentities")
  const existingIdentity = (await identities.findBy("channel", channel))
    .map((entry) => entry.doc)
    .find((entry) => entry.channel_user_id === channelUserId)

  let userId = existingIdentity?.user_id
  let isNewUser = false

  if (!userId) {
    const existingUser = (await (await col<UserDoc>("users")).scan())
      .map((entry) => entry.doc)
      .sort((a, b) => a.created_at - b.created_at)[0]
    if (!existingUser) throw new Error("No user found. Please run onboarding first.")

    userId = existingUser.id
    isNewUser = true
    const id = `${userId}:${channel}`
    const current = await identities.get(id)
    await identities.put(id, { user_id: userId, channel, channel_user_id: channelUserId, linked_at: Date.now() }, { expectedVersion: current?.version ?? 0 })
  }

  const agentId = await getDefaultAgentId()
  return { userId, agentId, isNewUser }
}

export async function getDefaultAgentId(): Promise<string> {
  const coordinatorAgent = (await (await col<AgentDoc>("agents")).findBy("role", "coordinator"))
    .map((entry) => entry.doc)[0]
  return coordinatorAgent?.id || "bee"
}

export async function getUserById(userId: string): Promise<UserDoc | null> {
  return (await (await col<UserDoc>("users")).get(userId))?.doc ?? null
}

export async function updateUserProfile(userId: string, updates: {
  name?: string
  language?: string
  timezone?: string
  occupation?: string
  notes?: string
}): Promise<void> {
  const users = await col<UserDoc>("users")
  const current = await users.get(userId)
  if (!current) return
  await users.put(userId, { ...current.doc, ...updates }, { expectedVersion: current.version })
}
