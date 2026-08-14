/**
 * Integration tests for the HiveDB capability discovery pipeline.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import type { SkillDoc } from "@johpaz/hivecode-core/storage/collections"
import { syncToolCatalogToIndex } from "@johpaz/hivecode-core/agent/tool-selector"
import { syncSkillsToIndex } from "@johpaz/hivecode-core/agent/skill-selector"
import { syncMCPToolsToDB, syncMCPToolsToIndex } from "@johpaz/hivecode-core/mcp/tool-sync"
import { searchKnowledgeTool } from "@johpaz/hivecode-core/tools/core/index"

const previousHiveDbPath = process.env.HIVE_DB_PATH
const testDbPath = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-index-test-")), "hivedb")
process.env.HIVE_DB_PATH = testDbPath

async function putSkill(doc: SkillDoc): Promise<void> {
  await (await col<SkillDoc>("skills")).put(doc.id, doc, { expectedVersion: 0 })
}

beforeAll(async () => {
  const now = Math.floor(Date.now() / 1000)

  await putSkill({
    id: "skill-web-research",
    name: "web_research",
    description: "Research information on the web using search and fetch tools",
    version: "1.0.0",
    author: "test",
    icon: "search",
    category: "research",
    permissions: "[]",
    dependencies: "[]",
    tools: "web_search,web_fetch",
    triggers: "buscar,investigar,research,find information,buscar en internet",
    preferred_agents: "[]",
    body: "# Web Research\nUsa web_search para buscar y web_fetch para obtener contenido detallado de paginas.",
    version_num: 1,
    active: true,
    created_at: now,
    updated_at: now,
  })

  await putSkill({
    id: "skill-file-ops",
    name: "file_operations",
    description: "Read write and edit files in the workspace efficiently",
    version: "1.0.0",
    author: "test",
    icon: "file",
    category: "filesystem",
    permissions: "[]",
    dependencies: "[]",
    tools: "fs_read,fs_write,fs_edit,fs_list",
    triggers: "archivo,file,leer,escribir,editar,read file,write file",
    preferred_agents: "[]",
    body: "# File Operations\nUsa fs_read para leer, fs_write para crear y fs_edit para modificar archivos.",
    version_num: 1,
    active: true,
    created_at: now,
    updated_at: now,
  })

  await syncToolCatalogToIndex()
  await syncSkillsToIndex()
  await syncMCPToolsToDB("srv-test-001", "servidor-prueba", [
    { name: "send_email", description: "Send email message to recipient with subject body and attachments" },
    { name: "list_calendar", description: "List calendar events and meetings for a date range" },
  ])
  await syncMCPToolsToIndex()
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

describe("HiveDB capability index - native tools", () => {
  test("encuentra web_search por consulta en espanol", async () => {
    const res = await searchKnowledgeTool.execute({ query: "buscar internet", type: "tools" }) as any
    expect(res.tools.map((t: any) => t.name)).toContain("web_search")
  })

  test("encuentra filesystem por intencion de lectura", async () => {
    const res = await searchKnowledgeTool.execute({ query: "leer archivo", type: "tools" }) as any
    expect(res.tools.map((t: any) => t.name)).toContain("fs_read")
  })

  test("mantiene metadatos de categoria y descripcion", async () => {
    const res = await searchKnowledgeTool.execute({ query: "buscar internet", type: "tools" }) as any
    const tool = res.tools.find((t: any) => t.name === "web_search")
    expect(tool?.category).toBe("web")
    expect(tool?.description).toBeTruthy()
  })
})

describe("HiveDB capability index - MCP tools", () => {
  test("encuentra tools MCP y conserva server_name", async () => {
    const res = await searchKnowledgeTool.execute({ query: "send email message", type: "mcp" }) as any
    const tool = res.toolsmcp.find((t: any) => t.tool_name === "send_email")
    expect(tool?.server_name).toBe("servidor-prueba")
  })

  test("no mezcla MCP cuando type=tools", async () => {
    const res = await searchKnowledgeTool.execute({ query: "send email", type: "tools" }) as any
    expect(res.toolsmcp).toHaveLength(0)
  })
})

describe("HiveDB capability index - skills", () => {
  test("encuentra skills insertadas en HiveDB", async () => {
    const res = await searchKnowledgeTool.execute({ query: "investigar buscar web", type: "skills" }) as any
    expect(res.skills.map((s: any) => s.id)).toContain("skill-web-research")
  })

  test("type=all combina herramientas y skills", async () => {
    const res = await searchKnowledgeTool.execute({ query: "web", type: "all" }) as any
    expect(res.tools.some((t: any) => t.name === "web_search")).toBe(true)
    expect(res.skills.some((s: any) => s.id === "skill-web-research")).toBe(true)
  })
})
