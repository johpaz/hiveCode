/**
 * Agent commands — manage Hive-Code agents/sub-agents.
 *
 * hive-code agent list [--coordinator <name>]
 * hive-code agent inspect <name>
 * hive-code agent edit <name>
 * hive-code agent reset <name>
 */

import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveText, isCancel,
} from "../ui/index.ts"
import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { spawn } from "child_process"

export async function agentList(args: string[] = []): Promise<void> {
  hiveIntro("hive-code · Agentes")

  const coordinatorFilter = args.find(a => a.startsWith("--coordinator="))?.split("=")[1]

  const db = getDb()
  let query = "SELECT id, name, role, coordinator, model_id, enabled FROM agents WHERE 1=1"
  const params: string[] = []

  if (coordinatorFilter) {
    query += " AND (coordinator = ? OR role = ?)"
    params.push(coordinatorFilter, coordinatorFilter)
  }

  query += " ORDER BY role, id"
  const rows = db.query(query).all(...params) as any[]

  if (rows.length === 0) {
    hiveNote("Sin agentes", ["No hay agentes configurados."])
    hiveOutro("Sin agentes")
    return
  }

  for (const row of rows) {
    const statusIcon = row.enabled ? "●" : "○"
    const color = row.enabled ? "\x1b[38;5;114m" : "\x1b[38;5;240m"
    hivePhaseComplete(row.coordinator || row.role, `${row.name}`)
    process.stdout.write(`  │    ${color}${statusIcon}\x1b[0m  ${row.role}`)
    if (row.model_id) process.stdout.write(`  ·  ${row.model_id}`)
    process.stdout.write(`\n  │\n`)
  }

  hiveOutro(`${rows.length} agente(s)`)
}

export async function agentInspect(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hive-code agent inspect <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  const row = db.query("SELECT * FROM agents WHERE id = ? OR name = ?").get(name, name) as any

  if (!row) {
    hiveOutro(`Agente no encontrado: ${name}`, "error")
    process.exit(1)
  }

  hiveIntro(`hive-code · Agente: ${row.name}`)

  console.log(`\n  \x1b[1mID:\x1b[0m           ${row.id}`)
  console.log(`  \x1b[1mNombre:\x1b[0m       ${row.name}`)
  console.log(`  \x1b[1mRol:\x1b[0m          ${row.role}`)
  console.log(`  \x1b[1mCoordinador:\x1b[0m  ${row.coordinator || "N/A"}`)
  console.log(`  \x1b[1mModelo:\x1b[0m       ${row.model_id || "default"}`)
  console.log(`  \x1b[1mHabilitado:\x1b[0m   ${row.enabled ? "Sí" : "No"}`)
  console.log(`  \x1b[1mMax iter:\x1b[0m     ${row.max_iterations || 10}`)
  console.log(``)

  if (row.system_prompt) {
    const preview = row.system_prompt.slice(0, 500).replace(/\n/g, "\n  │    ")
    console.log(`  \x1b[1mSystem Prompt:\x1b[0m\n  │    ${preview}...\n`)
  }

  hiveOutro("Agente inspeccionado")
}

export async function agentEdit(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hive-code agent edit <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  const row = db.query("SELECT id, system_prompt FROM agents WHERE id = ? OR name = ?").get(name, name) as any

  if (!row) {
    hiveOutro(`Agente no encontrado: ${name}`, "error")
    process.exit(1)
  }

  // Create temp file with current prompt
  const tmpFile = `/tmp/hive-agent-${row.id}-${Date.now()}.md`
  await Bun.write(tmpFile, row.system_prompt || "")

  // Open in $EDITOR
  const editor = process.env.EDITOR || "nano"
  const proc = spawn(editor, [tmpFile], { stdio: "inherit" })

  await new Promise((resolve) => proc.on("close", resolve))

  // Read back
  const newPrompt = await Bun.file(tmpFile).text()
  db.query("UPDATE agents SET system_prompt = ? WHERE id = ?").run(newPrompt, row.id)

  // Cleanup
  try { await Bun.file(tmpFile).delete() } catch {}

  hiveOutro(`System prompt de ${name} actualizado`)
}

export async function agentReset(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hive-code agent reset <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  const row = db.query("SELECT id, role, coordinator FROM agents WHERE id = ? OR name = ?").get(name, name) as any

  if (!row) {
    hiveOutro(`Agente no encontrado: ${name}`, "error")
    process.exit(1)
  }

  // Reset to default prompt based on role/coordinator
  const defaultPrompts: Record<string, string> = {
    coordinator: "Eres un coordinador de Hive-Code.",
    subagent: `Eres un sub-agente especializado de Hive-Code (${row.coordinator || "general"}).`,
  }

  const defaultPrompt = defaultPrompts[row.role] || "Eres un agente de Hive-Code."
  db.query("UPDATE agents SET system_prompt = ? WHERE id = ?").run(defaultPrompt, row.id)

  hiveOutro(`System prompt de ${name} restaurado`)
}
