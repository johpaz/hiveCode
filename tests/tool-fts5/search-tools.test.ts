/**
 * Integration tests — FTS5 tool/skill/MCP discovery pipeline
 *
 * Verifica que el sistema real funcione de extremo a extremo:
 *   1. syncToolCatalogToFTS()  → tools_fts     → search_knowledge(type="tools")
 *   2. syncMCPToolsToDB/FTS()  → mcp_tools_fts → search_knowledge(type="mcp")
 *   3. syncSkillsToFTS()       → skills_fts    → search_knowledge(type="skills")
 *
 * Usa SQLite :memory: con los schemas reales y _setDb() para inyectar la DB.
 * Sin mocks. Si una función falla, el test falla.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA, CONTEXT_ENGINE_SCHEMA } from "@johpaz/hivecode-core/storage/schema"
import { _setDb, _resetDb } from "@johpaz/hivecode-core/storage/sqlite"
import { syncToolCatalogToFTS } from "@johpaz/hivecode-core/agent/tool-selector"
import { syncSkillsToFTS } from "@johpaz/hivecode-core/agent/skill-selector"
import { syncMCPToolsToDB, syncMCPToolsToFTS } from "@johpaz/hivecode-core/mcp/tool-sync"
import { searchKnowledgeTool } from "@johpaz/hivecode-core/tools/core/index"

// ── DB setup ──────────────────────────────────────────────────────────────────

let db: Database

function makeTestDb(): Database {
  const d = new Database(":memory:")
  // FK off para evitar dependencias de fixtures en users/agents
  d.run("PRAGMA foreign_keys = OFF")
  // Esquemas reales: tablas, índices y tablas FTS5
  d.exec(SCHEMA)
  d.exec(CONTEXT_ENGINE_SCHEMA)
  return d
}

beforeAll(async () => {
  db = makeTestDb()
  _setDb(db)

  // Cargar catálogo nativo de herramientas en tools_fts
  await syncToolCatalogToFTS()
})

afterAll(() => {
  db.close()
  _resetDb()
})

// ── Herramientas nativas (tools_fts) ─────────────────────────────────────────

describe("FTS5 — herramientas nativas", () => {
  test("tools_fts tiene herramientas indexadas", () => {
    const { n } = db.query("SELECT COUNT(*) as n FROM tools_fts").get() as { n: number }
    expect(n).toBeGreaterThan(40) // CORE_TOOL_CATALOG tiene ~60 tools
  })

  test("buscar 'buscar internet' encuentra web_search", async () => {
    const res = await searchKnowledgeTool.execute({ query: "buscar internet", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("web_search")
  })

  test("buscar 'descargar página' encuentra web_fetch", async () => {
    const res = await searchKnowledgeTool.execute({ query: "descargar página web", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("web_fetch")
  })

  test("buscar 'leer archivo' encuentra fs_read", async () => {
    const res = await searchKnowledgeTool.execute({ query: "leer archivo", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("fs_read")
  })

  test("buscar 'crear archivo' encuentra fs_write", async () => {
    const res = await searchKnowledgeTool.execute({ query: "crear archivo", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("fs_write")
  })

  test("buscar 'programar recordatorio' encuentra cron.create", async () => {
    const res = await searchKnowledgeTool.execute({ query: "programar recordatorio", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names.some((n: string) => n.startsWith("cron."))).toBe(true)
  })

  test("buscar 'crear proyecto nuevo' encuentra project_create", async () => {
    const res = await searchKnowledgeTool.execute({ query: "crear proyecto nuevo", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names.some((n: string) => n.startsWith("project_"))).toBe(true)
  })

  test("buscar 'guardar memoria' encuentra memory_write", async () => {
    const res = await searchKnowledgeTool.execute({ query: "guardar memoria", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("memory_write")
  })

  test("buscar 'commit cambios git' encuentra git_commit", async () => {
    const res = await searchKnowledgeTool.execute({ query: "commit cambios git", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names.some((n: string) => n.startsWith("git_"))).toBe(true)
  })

  test("query en inglés también encuentra herramientas", async () => {
    const res = await searchKnowledgeTool.execute({ query: "search web internet", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("web_search")
  })

  test("resultado incluye category y description", async () => {
    const res = await searchKnowledgeTool.execute({ query: "buscar internet", type: "tools" }) as any
    const tool = res.tools.find((t: any) => t.name === "web_search")
    expect(tool).toBeDefined()
    expect(tool.category).toBe("web")
    expect(tool.description).toBeTruthy()
  })
})

// ── Herramientas MCP (mcp_tools_fts) ─────────────────────────────────────────

describe("FTS5 — MCP tools", () => {
  const SERVER_ID = "srv-test-001"
  const SERVER_NAME = "servidor-prueba"

  beforeAll(async () => {
    // Sincronizar tools MCP reales: primero a mcp_tools, luego al índice FTS5
    syncMCPToolsToDB(SERVER_ID, SERVER_NAME, [
      { name: "send_email",    description: "Send email message to recipient with subject body and attachments" },
      { name: "list_calendar", description: "List calendar events and meetings for a date range" },
      { name: "create_meeting", description: "Create calendar meeting invite and send to participants" },
      { name: "slack_message", description: "Send message to Slack channel or direct message" },
    ])
    await syncMCPToolsToFTS()
  })

  test("mcp_tools_fts tiene los tools del servidor", () => {
    const { n } = db.query(
      "SELECT COUNT(*) as n FROM mcp_tools WHERE server_id = ?"
    ).get(SERVER_ID) as { n: number }
    expect(n).toBe(4)
  })

  test("buscar 'send email message' encuentra send_email", async () => {
    // Descripciones MCP están en inglés → query en inglés funciona directo
    const res = await searchKnowledgeTool.execute({ query: "send email message", type: "mcp" }) as any
    expect(res.toolsmcp.length).toBeGreaterThan(0)
    const toolNames = res.toolsmcp.map((t: any) => t.tool_name)
    expect(toolNames).toContain("send_email")
  })

  test("buscar 'calendar events' encuentra list_calendar", async () => {
    const res = await searchKnowledgeTool.execute({ query: "calendar events meetings", type: "mcp" }) as any
    const toolNames = res.toolsmcp.map((t: any) => t.tool_name)
    expect(toolNames).toContain("list_calendar")
  })

  test("buscar 'slack channel message' encuentra slack_message", async () => {
    const res = await searchKnowledgeTool.execute({ query: "slack channel message", type: "mcp" }) as any
    const toolNames = res.toolsmcp.map((t: any) => t.tool_name)
    expect(toolNames).toContain("slack_message")
  })

  test("MCP tools NO contaminan búsqueda type='tools'", async () => {
    const res = await searchKnowledgeTool.execute({ query: "send email", type: "tools" }) as any
    // toolsmcp debe estar vacío cuando type=tools
    expect(res.toolsmcp.length).toBe(0)
  })

  test("resultado MCP incluye server_name", async () => {
    const res = await searchKnowledgeTool.execute({ query: "send email message", type: "mcp" }) as any
    const tool = res.toolsmcp.find((t: any) => t.tool_name === "send_email")
    expect(tool?.server_name).toBe(SERVER_NAME)
  })
})

// ── Skills (skills_fts) ───────────────────────────────────────────────────────

describe("FTS5 — skills", () => {
  beforeAll(async () => {
    // Insertar skills reales en la tabla skills
    db.run(`INSERT OR IGNORE INTO skills(id, name, description, category, tools, triggers, body, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, [
      "skill-web-research",
      "web_research",
      "Research information on the web using search and fetch tools",
      "research",
      "web_search,web_fetch",
      "buscar,investigar,research,find information,buscar en internet",
      "# Web Research\nUsa web_search para buscar y web_fetch para obtener contenido detallado de páginas.",
    ])
    db.run(`INSERT OR IGNORE INTO skills(id, name, description, category, tools, triggers, body, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, [
      "skill-file-ops",
      "file_operations",
      "Read write and edit files in the workspace efficiently",
      "filesystem",
      "fs_read,fs_write,fs_edit,fs_list",
      "archivo,file,leer,escribir,editar,read file,write file",
      "# File Operations\nUsa fs_read para leer, fs_write para crear, fs_edit para modificar archivos.",
    ])
    db.run(`INSERT OR IGNORE INTO skills(id, name, description, category, tools, triggers, body, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, [
      "skill-git-workflow",
      "git_workflow",
      "Manage git repository: status diff log branch commit",
      "code",
      "git_status,git_diff,git_commit,git_log",
      "git,commit,branch,repositorio,versiones,diff",
      "# Git Workflow\nRevisa con git_status, examina con git_diff, confirma con git_commit.",
    ])

    // Indexar en skills_fts
    await syncSkillsToFTS()
  })

  test("skills_fts tiene las skills insertadas", () => {
    const { n } = db.query("SELECT COUNT(*) as n FROM skills_fts").get() as { n: number }
    expect(n).toBe(3)
  })

  test("buscar 'investigar buscar web' encuentra web_research", async () => {
    const res = await searchKnowledgeTool.execute({ query: "investigar buscar web", type: "skills" }) as any
    const ids = res.skills.map((s: any) => s.id)
    expect(ids).toContain("skill-web-research")
  })

  test("buscar 'leer escribir archivo' encuentra file_operations", async () => {
    const res = await searchKnowledgeTool.execute({ query: "leer escribir archivo", type: "skills" }) as any
    const ids = res.skills.map((s: any) => s.id)
    expect(ids).toContain("skill-file-ops")
  })

  test("buscar 'git commit branch' encuentra git_workflow", async () => {
    const res = await searchKnowledgeTool.execute({ query: "git commit branch", type: "skills" }) as any
    const ids = res.skills.map((s: any) => s.id)
    expect(ids).toContain("skill-git-workflow")
  })

  test("resultado skill incluye body (instrucciones)", async () => {
    const res = await searchKnowledgeTool.execute({ query: "buscar web", type: "skills" }) as any
    const skill = res.skills.find((s: any) => s.id === "skill-web-research")
    expect(skill?.body).toBeTruthy()
    expect(skill?.tools).toContain("web_search")
  })

  test("skills NO aparecen en búsqueda type='tools'", async () => {
    const res = await searchKnowledgeTool.execute({ query: "investigar web", type: "tools" }) as any
    expect(res.skills.length).toBe(0)
  })
})

// ── Búsqueda combinada type=all ───────────────────────────────────────────────

describe("FTS5 — type=all combina tools + MCP + skills", () => {
  test("query 'buscar web' retorna tools Y skills en una sola llamada", async () => {
    const res = await searchKnowledgeTool.execute({ query: "buscar web", type: "all" }) as any
    // Debe encontrar al menos web_search (tools) y web_research (skills)
    const total = res.tools.length + res.skills.length + res.toolsmcp.length
    expect(total).toBeGreaterThan(1)
    expect(res.tools.some((t: any) => t.name === "web_search")).toBe(true)
    expect(res.skills.some((s: any) => s.id === "skill-web-research")).toBe(true)
  })

  test("query 'calendar meeting events' retorna MCP tools en type=all", async () => {
    const res = await searchKnowledgeTool.execute({ query: "calendar meeting events", type: "all" }) as any
    expect(res.toolsmcp.length).toBeGreaterThan(0)
  })

  test("resultado tiene estructura completa: tools, skills, toolsmcp, playbook, code", async () => {
    const res = await searchKnowledgeTool.execute({ query: "buscar web", type: "all" }) as any
    expect(res).toHaveProperty("tools")
    expect(res).toHaveProperty("skills")
    expect(res).toHaveProperty("toolsmcp")
    expect(res).toHaveProperty("playbook")
    expect(res).toHaveProperty("code")
    expect(Array.isArray(res.tools)).toBe(true)
    expect(Array.isArray(res.skills)).toBe(true)
  })
})

// ── Fallback bilingüe ES → EN ─────────────────────────────────────────────────

describe("FTS5 — keywords en español indexadas", () => {
  // buildFtsMatch usa AND para múltiples palabras → todos los términos deben aparecer
  // en la descripción enriquecida. Las tools tienen keywords bilingües en su descripción.

  test("'noticias' (palabra española) encuentra web_search", async () => {
    // web_search description incluye "noticias" en sus Spanish keywords
    const res = await searchKnowledgeTool.execute({ query: "noticias", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("web_search")
  })

  test("'recordatorio' encuentra cron tools", async () => {
    // cron.create description incluye "recordatorio" en sus Spanish keywords
    const res = await searchKnowledgeTool.execute({ query: "recordatorio", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names.some((n: string) => n.startsWith("cron."))).toBe(true)
  })

  test("'agente' encuentra tools de gestión de agentes", async () => {
    // agent_create / agent_find description incluye "agente" en Spanish keywords
    const res = await searchKnowledgeTool.execute({ query: "agente", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names.some((n: string) => n.startsWith("agent_"))).toBe(true)
  })
})

// ── Patrón worker: una sola palabra ──────────────────────────────────────────
//
// buildFtsMatch con UNA palabra usa: `"word" OR word*`  → OR → retorna TODO lo relacionado
// buildFtsMatch con MÚLTIPLES palabras usa: `a* AND b*` → AND → muy restrictivo
//
// Los workers DEBEN usar una sola palabra para descubrir herramientas.
// La skill busqueda_fts5 enseña este patrón.

describe("FTS5 — patrón worker: una sola palabra descubre todo el dominio", () => {
  test('"web" retorna web_search Y web_fetch en una query', async () => {
    const res = await searchKnowledgeTool.execute({ query: "web", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("web_search")
    expect(names).toContain("web_fetch")
  })

  test('"file" retorna todo el dominio filesystem', async () => {
    const res = await searchKnowledgeTool.execute({ query: "file", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("fs_read")
    expect(names).toContain("fs_write")
    expect(names).toContain("fs_edit")
  })

  test('"memory" retorna todo el dominio memoria', async () => {
    const res = await searchKnowledgeTool.execute({ query: "memory", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("memory_write")
    expect(names).toContain("memory_read")
    expect(names).toContain("memory_search")
  })

  test('"cron" retorna todas las tools de scheduling', async () => {
    const res = await searchKnowledgeTool.execute({ query: "cron", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("cron.create")
    expect(names).toContain("cron.list")
    expect(names).toContain("cron.delete")
  })

  test('"git" retorna todo el dominio git', async () => {
    const res = await searchKnowledgeTool.execute({ query: "git", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("git_status")
    expect(names).toContain("git_diff")
    expect(names).toContain("git_commit")
  })

  test('"agent" retorna tools de gestión de agentes y delegación', async () => {
    const res = await searchKnowledgeTool.execute({ query: "agent", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names.some((n: string) => n.startsWith("agent_") || n.startsWith("task_delegate"))).toBe(true)
  })

  test('"canvas" retorna todas las tools de UI', async () => {
    const res = await searchKnowledgeTool.execute({ query: "canvas", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("canvas_render")
    expect(names).toContain("canvas_ask")
    expect(names).toContain("canvas_confirm")
  })

  test('"browser" retorna tools de automatización web', async () => {
    const res = await searchKnowledgeTool.execute({ query: "browser", type: "tools" }) as any
    const names = res.tools.map((t: any) => t.name)
    expect(names).toContain("browser_navigate")
    expect(names).toContain("browser_click")
    expect(names).toContain("browser_type")
  })

  test('"web" con type=all retorna tools Y la skill web_research', async () => {
    const res = await searchKnowledgeTool.execute({ query: "web", type: "all" }) as any
    const toolNames = res.tools.map((t: any) => t.name)
    const skillIds = res.skills.map((s: any) => s.id)
    // Tools
    expect(toolNames).toContain("web_search")
    expect(toolNames).toContain("web_fetch")
    // Skill (cargada en beforeAll de describe "FTS5 — skills")
    expect(skillIds).toContain("skill-web-research")
  })

  test('"file" con type=all retorna tools Y la skill file_operations', async () => {
    const res = await searchKnowledgeTool.execute({ query: "file", type: "all" }) as any
    const toolNames = res.tools.map((t: any) => t.name)
    const skillIds = res.skills.map((s: any) => s.id)
    expect(toolNames).toContain("fs_read")
    expect(skillIds).toContain("skill-file-ops")
  })
})
