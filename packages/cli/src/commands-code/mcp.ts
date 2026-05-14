/**
 * MCP commands — manage MCP servers.
 *
 * hivecode mcp list
 * hivecode mcp add <url-or-name>
 * hivecode mcp remove <name>
 * hivecode mcp enable <name>
 * hivecode mcp disable <name>
 * hivecode mcp test <name>
 * hivecode mcp inspect <name>
 */

import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveSpinner, hiveText, isCancel,
} from "@johpaz/hivecode-ui"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

export async function mcpList(): Promise<void> {
  hiveIntro("hivecode · MCP Servers")

  const db = getDb()
  const rows = db.query("SELECT id, name, transport, url, command, enabled, status, tools_count FROM mcp_servers ORDER BY id").all() as any[]

  if (rows.length === 0) {
    hiveNote("Sin MCPs", ["No hay servidores MCP configurados. Usa 'hivecode mcp add <url>'"])
    hiveOutro("Sin MCPs")
    return
  }

  for (const row of rows) {
    const statusColor = row.status === "connected" ? "\x1b[38;5;114m" : "\x1b[38;5;214m"
    const statusIcon = row.enabled ? "●" : "○"
    hivePhaseComplete(row.id, `${row.name}`)
    process.stdout.write(`  │    ${statusColor}${statusIcon}\x1b[0m  ${row.transport}`)
    if (row.url) process.stdout.write(`  ·  ${row.url}`)
    if (row.command) process.stdout.write(`  ·  ${row.command}`)
    process.stdout.write(`  ·  ${row.status || "unknown"}`)
    if (row.tools_count) process.stdout.write(`  ·  ${row.tools_count} tools`)
    process.stdout.write(`\n  │\n`)
  }

  hiveOutro(`${rows.length} MCP server(s)`)
}

export async function mcpAdd(urlOrName?: string): Promise<void> {
  hiveIntro("hivecode · Añadir MCP")

  const input = urlOrName ?? await hiveText({
    message: "URL o nombre del MCP server:",
    placeholder: "http://localhost:3000/sse  o  filesystem",
  })

  if (isCancel(input) || !input || typeof input !== "string") {
    hiveOutro("Cancelado", "error")
    return
  }

  const db = getDb()
  const id = input.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()

  // Detect if URL or command-based
  const isUrl = input.startsWith("http://") || input.startsWith("https://")
  const transport = isUrl ? "sse" : "stdio"

  db.query(`
    INSERT OR REPLACE INTO mcp_servers (id, name, transport, url, command, enabled, active, builtin, status)
    VALUES (?, ?, ?, ?, ?, 1, 0, 0, 'disconnected')
  `).run(id, input, transport, isUrl ? input : null, isUrl ? null : input)

  hiveOutro(`MCP ${id} añadido (${transport})`)
}

export async function mcpRemove(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode mcp remove <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  db.query("DELETE FROM mcp_servers WHERE id = ?").run(name)
  hiveOutro(`MCP ${name} eliminado`)
}

export async function mcpEnable(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode mcp enable <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  db.query("UPDATE mcp_servers SET enabled = 1 WHERE id = ?").run(name)
  hiveOutro(`MCP ${name} habilitado`)
}

export async function mcpDisable(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode mcp disable <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  db.query("UPDATE mcp_servers SET enabled = 0 WHERE id = ?").run(name)
  hiveOutro(`MCP ${name} deshabilitado`)
}

export async function mcpTest(name?: string): Promise<void> {
  hiveIntro("hivecode · Test MCP")

  const mcpId = name ?? await hiveText({
    message: "MCP a probar:",
    placeholder: "filesystem, github...",
  })

  if (isCancel(mcpId) || !mcpId || typeof mcpId !== "string") {
    hiveOutro("Cancelado", "error")
    return
  }

  const db = getDb()
  const row = db.query("SELECT id, url, transport FROM mcp_servers WHERE id = ?").get(mcpId) as any

  if (!row) {
    hiveOutro(`MCP no encontrado: ${mcpId}`, "error")
    process.exit(1)
  }

  const spinner = hiveSpinner("default")
  spinner.start(`Probando ${mcpId}...`)

  try {
    if (row.transport === "sse" && row.url) {
      const response = await fetch(row.url, { method: "GET" })
      const ok = response.ok
      spinner.stop(ok ? `${mcpId} responde` : `${mcpId} error HTTP ${response.status}`)
      hiveOutro(ok ? `${mcpId} OK` : `${mcpId} falló`)
    } else {
      spinner.stop(`${mcpId} es STDIO — verifica manualmente`)
      hiveOutro(`${mcpId} requiere verificación manual`)
    }
  } catch (err) {
    spinner.stop(`Error: ${(err as Error).message}`, "error")
    hiveOutro(`${mcpId} no responde`, "error")
  }
}

export async function mcpInspect(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode mcp inspect <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  const row = db.query("SELECT * FROM mcp_servers WHERE id = ?").get(name) as any

  if (!row) {
    hiveOutro(`MCP no encontrado: ${name}`, "error")
    process.exit(1)
  }

  hiveIntro(`hivecode · MCP: ${row.name}`)

  console.log(`\n  \x1b[1mID:\x1b[0m        ${row.id}`)
  console.log(`  \x1b[1mNombre:\x1b[0m    ${row.name}`)
  console.log(`  \x1b[1mTransport:\x1b[0m ${row.transport}`)
  console.log(`  \x1b[1mURL:\x1b[0m       ${row.url || "N/A"}`)
  console.log(`  \x1b[1mCommand:\x1b[0m   ${row.command || "N/A"}`)
  console.log(`  \x1b[1mArgs:\x1b[0m      ${row.args || "N/A"}`)
  console.log(`  \x1b[1mEnabled:\x1b[0m   ${row.enabled ? "Sí" : "No"}`)
  console.log(`  \x1b[1mStatus:\x1b[0m    ${row.status || "unknown"}`)
  console.log(`  \x1b[1mTools:\x1b[0m     ${row.tools_count || 0}`)
  console.log(``)

  hiveOutro("MCP inspeccionado")
}
