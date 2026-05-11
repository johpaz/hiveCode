/**
 * Skill commands — manage Hive-Code skills.
 *
 * hive-code skill list
 * hive-code skill enable <name>
 * hive-code skill disable <name>
 * hive-code skill add <path>
 * hive-code skill remove <name>
 * hive-code skill inspect <name>
 * hive-code skill assign <skill> <coordinator>
 */

import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveSpinner, hiveText, isCancel,
} from "../ui/index.ts"
import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { ensureCodeDatabase } from "./db-init"

export async function skillList(): Promise<void> {
  ensureCodeDatabase()
  hiveIntro("hive-code · Skills")

  const db = getDb()
  const rows = db.query("SELECT id, name, description, enabled, category FROM skills ORDER BY id").all() as any[]

  if (rows.length === 0) {
    hiveNote("Sin skills", ["No hay skills registradas."])
    hiveOutro("Sin skills")
    return
  }

  for (const row of rows) {
    const statusIcon = row.enabled ? "●" : "○"
    const color = row.enabled ? "\x1b[38;5;114m" : "\x1b[38;5;240m"
    hivePhaseComplete(row.id, `${row.name}`)
    process.stdout.write(`  │    ${color}${statusIcon}\x1b[0m  ${row.category || "general"}  ·  ${row.description?.slice(0, 60) || ""}...\n  │\n`)
  }

  hiveOutro(`${rows.length} skill(s)`)
}

export async function skillEnable(name?: string): Promise<void> {
  ensureCodeDatabase()

  if (!name) {
    hiveOutro("Uso: hive-code skill enable <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  db.query("UPDATE skills SET enabled = 1 WHERE id = ?").run(name)
  hiveOutro(`Skill ${name} habilitada`)
}

export async function skillDisable(name?: string): Promise<void> {
  ensureCodeDatabase()

  if (!name) {
    hiveOutro("Uso: hive-code skill disable <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  db.query("UPDATE skills SET enabled = 0 WHERE id = ?").run(name)
  hiveOutro(`Skill ${name} deshabilitada`)
}

export async function skillAdd(pathArg?: string): Promise<void> {
  ensureCodeDatabase()
  hiveIntro("hive-code · Añadir Skill")

  const filePath = pathArg ?? await hiveText({
    message: "Ruta al archivo .md de la skill:",
    placeholder: "/path/to/skill.md",
  })

  if (isCancel(filePath) || !filePath || typeof filePath !== "string") {
    hiveOutro("Cancelado", "error")
    return
  }

  try {
    const content = await Bun.file(filePath).text()
    const nameMatch = content.match(/^#\s+(.+)/m)
    const name = nameMatch ? nameMatch[1].trim() : filePath.split("/").pop()?.replace(".md", "") || "custom"
    const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")

    const db = getDb()
    db.query(`
      INSERT OR REPLACE INTO skills (id, name, description, content, enabled)
      VALUES (?, ?, ?, ?, 1)
    `).run(id, name, `Imported from ${filePath}`, content)

    hiveOutro(`Skill ${id} añadida`)
  } catch (err) {
    hiveOutro(`Error leyendo ${filePath}: ${(err as Error).message}`, "error")
    process.exit(1)
  }
}

export async function skillRemove(name?: string): Promise<void> {
  ensureCodeDatabase()

  if (!name) {
    hiveOutro("Uso: hive-code skill remove <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  db.query("DELETE FROM skills WHERE id = ?").run(name)
  hiveOutro(`Skill ${name} eliminada`)
}

export async function skillInspect(name?: string): Promise<void> {
  ensureCodeDatabase()

  if (!name) {
    hiveOutro("Uso: hive-code skill inspect <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  const row = db.query("SELECT * FROM skills WHERE id = ?").get(name) as any

  if (!row) {
    hiveOutro(`Skill no encontrada: ${name}`, "error")
    process.exit(1)
  }

  hiveIntro(`hive-code · Skill: ${row.name}`)

  console.log(`\n  \x1b[1mID:\x1b[0m          ${row.id}`)
  console.log(`  \x1b[1mNombre:\x1b[0m      ${row.name}`)
  console.log(`  \x1b[1mDescripción:\x1b[0m ${row.description || "N/A"}`)
  console.log(`  \x1b[1mCategoría:\x1b[0m   ${row.category || "N/A"}`)
  console.log(`  \x1b[1mHabilitada:\x1b[0m  ${row.enabled ? "Sí" : "No"}`)
  console.log(`  \x1b[1mTriggers:\x1b[0m    ${row.triggers || "N/A"}`)
  console.log(``)

  if (row.content) {
    const preview = row.content.slice(0, 500).replace(/\n/g, "\n  │    ")
    console.log(`  \x1b[1mContenido:\x1b[0m\n  │    ${preview}...\n`)
  }

  hiveOutro("Skill inspeccionada")
}

export async function skillAssign(args: string[]): Promise<void> {
  ensureCodeDatabase()

  const skillName = args[0]
  const coordinator = args[1]

  if (!skillName || !coordinator) {
    hiveOutro("Uso: hive-code skill assign <skill> <coordinator>", "error")
    process.exit(1)
  }

  const db = getDb()
  db.query("UPDATE skills SET category = ? WHERE id = ?").run(coordinator, skillName)
  hiveOutro(`Skill ${skillName} asignada a ${coordinator}`)
}
