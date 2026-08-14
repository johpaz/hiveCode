import { col } from "../../storage/hive"
import type { SkillDoc } from "../../storage/collections"

export async function handleGetSkills(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const skills = (await (await col<SkillDoc>("skills")).scan())
    .map((entry) => entry.doc)
    .sort((a, b) => a.name.localeCompare(b.name))

  return addCorsHeaders(Response.json({
    skills: skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      tools: s.tools,
      triggers: s.triggers,
      preferred_agents: s.preferred_agents,
      body: s.body,
      version: s.version,
      version_num: s.version_num,
      active: s.active,
    }))
  }), req)
}

export async function handleActivateSkill(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split("/").filter(Boolean)
  const skillId = parts[2]
  const body = await req.json().catch(() => ({}))
  const { active } = body

  if (!skillId) {
    return addCorsHeaders(Response.json({ success: false, error: "skillId required" }), req)
  }

  const skills = await col<SkillDoc>("skills")
  const existing = await skills.get(skillId)
  if (existing) {
    await skills.put(skillId, { ...existing.doc, active: !!active, updated_at: Date.now() }, { expectedVersion: existing.version })
  }

  return addCorsHeaders(Response.json({ success: true, skillId, active }), req)
}

export async function handleUpdateSkill(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split("/").filter(Boolean)
  const skillId = parts[2]
  const body = await req.json().catch(() => ({}))

  if (!skillId) {
    return addCorsHeaders(Response.json({ success: false, error: "skillId required" }), req)
  }

  const skills = await col<SkillDoc>("skills")
  const existing = await skills.get(skillId)
  if (!existing) return addCorsHeaders(Response.json({ success: false, error: "Skill not found" }, { status: 404 }), req)

  const patch: Partial<SkillDoc> = {}
  for (const key of ["name", "description", "category", "tools", "triggers", "body", "version"] as const) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  if (body.preferred_agents !== undefined) {
    patch.preferred_agents = typeof body.preferred_agents === "object"
      ? JSON.stringify(body.preferred_agents)
      : body.preferred_agents
  }
  if (body.active !== undefined) patch.active = !!body.active

  await skills.put(skillId, { ...existing.doc, ...patch, updated_at: Date.now() }, { expectedVersion: existing.version })
  return addCorsHeaders(Response.json({ success: true }), req)
}

export async function handleDeleteSkill(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const skillId = url.pathname.split("/").pop()

  if (!skillId) {
    return addCorsHeaders(Response.json({ success: false, error: "skillId required" }), req)
  }

  await (await col<SkillDoc>("skills")).delete(skillId)
  return addCorsHeaders(Response.json({ success: true }), req)
}

export async function handleCreateSkill(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response
): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { name, description, category, tools, triggers, preferred_agents, body: bodyContent } = body

  if (!name) {
    return addCorsHeaders(new Response("Missing name", { status: 400 }), req)
  }

  const id = crypto.randomUUID()
  const now = Date.now()
  const skill: SkillDoc = {
    id,
    name,
    description: description || "",
    version: "0.0.1",
    author: body.author || "user",
    icon: body.icon || "",
    category: category || "",
    permissions: body.permissions || "[]",
    dependencies: body.dependencies || "[]",
    tools: tools || "",
    triggers: triggers || "",
    preferred_agents: typeof preferred_agents === "object" ? JSON.stringify(preferred_agents || []) : (preferred_agents || "[]"),
    body: bodyContent || "",
    version_num: 1,
    active: true,
    created_at: now,
    updated_at: now,
  }
  await (await col<SkillDoc>("skills")).put(id, skill)
  return addCorsHeaders(Response.json({ success: true, id }), req)
}
