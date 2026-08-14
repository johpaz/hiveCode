/**
 * Skill commands — manage Hive-Code skills.
 *
 * hivecode skill list
 * hivecode skill enable <name>
 * hivecode skill disable <name>
 * hivecode skill add <path>
 * hivecode skill remove <name>
 * hivecode skill inspect <name>
 * hivecode skill assign <skill> <coordinator>
 */

import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveSpinner, hiveText, isCancel,
} from "../cli-ui.ts"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { SkillDoc } from "@johpaz/hivecode-core/storage/collections"

export async function skillList(): Promise<void> {
  hiveIntro("hivecode · Skills")

  const skills = await col<SkillDoc>("skills")
  const rows = (await skills.scan()).map((entry) => entry.doc).sort((a, b) => a.id.localeCompare(b.id))

  if (rows.length === 0) {
    hiveNote("Sin skills", ["No hay skills registradas."])
    hiveOutro("Sin skills")
    return
  }

  for (const row of rows) {
    const statusIcon = row.active ? "●" : "○"
    const color = row.active ? "\x1b[38;5;114m" : "\x1b[38;5;240m"
    hivePhaseComplete(row.id, `${row.name}`)
    process.stdout.write(`  │    ${color}${statusIcon}\x1b[0m  ${row.category || "general"}  ·  ${row.description?.slice(0, 60) || ""}...\n  │\n`)
  }

  hiveOutro(`${rows.length} skill(s)`)
}

export async function skillEnable(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode skill enable <name>", "error")
    process.exit(1)
  }

  const skills = await col<SkillDoc>("skills")
  const row = await skills.get(name)
  if (row) await skills.put(name, { ...row.doc, active: true, updated_at: Date.now() }, { expectedVersion: row.version })
  hiveOutro(`Skill ${name} habilitada`)
}

export async function skillDisable(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode skill disable <name>", "error")
    process.exit(1)
  }

  const skills = await col<SkillDoc>("skills")
  const row = await skills.get(name)
  if (row) await skills.put(name, { ...row.doc, active: false, updated_at: Date.now() }, { expectedVersion: row.version })
  hiveOutro(`Skill ${name} deshabilitada`)
}

export async function skillAdd(pathArg?: string): Promise<void> {
  hiveIntro("hivecode · Añadir Skill")

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

    const skills = await col<SkillDoc>("skills")
    const existing = await skills.get(id)
    const now = Date.now()
    await skills.put(id, {
      id,
      name,
      description: `Imported from ${filePath}`,
      version: "0.0.1",
      author: "local",
      icon: "skill",
      category: "custom",
      permissions: JSON.stringify([]),
      dependencies: JSON.stringify([]),
      tools: "",
      triggers: "",
      preferred_agents: JSON.stringify([]),
      body: content,
      version_num: 1,
      active: true,
      created_at: existing?.doc.created_at ?? now,
      updated_at: now,
    }, { expectedVersion: existing?.version ?? 0 })

    hiveOutro(`Skill ${id} añadida`)
  } catch (err) {
    hiveOutro(`Error leyendo ${filePath}: ${(err as Error).message}`, "error")
    process.exit(1)
  }
}

export async function skillRemove(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode skill remove <name>", "error")
    process.exit(1)
  }

  await (await col<SkillDoc>("skills")).delete(name)
  hiveOutro(`Skill ${name} eliminada`)
}

export async function skillInspect(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode skill inspect <name>", "error")
    process.exit(1)
  }

  const row = (await (await col<SkillDoc>("skills")).get(name))?.doc

  if (!row) {
    hiveOutro(`Skill no encontrada: ${name}`, "error")
    process.exit(1)
  }

  hiveIntro(`hivecode · Skill: ${row.name}`)

  console.log(`\n  \x1b[1mID:\x1b[0m          ${row.id}`)
  console.log(`  \x1b[1mNombre:\x1b[0m      ${row.name}`)
  console.log(`  \x1b[1mDescripción:\x1b[0m ${row.description || "N/A"}`)
  console.log(`  \x1b[1mCategoría:\x1b[0m   ${row.category || "N/A"}`)
  console.log(`  \x1b[1mHabilitada:\x1b[0m  ${row.active ? "Sí" : "No"}`)
  console.log(`  \x1b[1mTriggers:\x1b[0m    ${row.triggers || "N/A"}`)
  console.log(``)

  if (row.body) {
    const preview = row.body.slice(0, 500).replace(/\n/g, "\n  │    ")
    console.log(`  \x1b[1mContenido:\x1b[0m\n  │    ${preview}...\n`)
  }

  hiveOutro("Skill inspeccionada")
}

export async function skillAssign(args: string[]): Promise<void> {

  const skillName = args[0]
  const coordinator = args[1]

  if (!skillName || !coordinator) {
    hiveOutro("Uso: hivecode skill assign <skill> <coordinator>", "error")
    process.exit(1)
  }

  const skills = await col<SkillDoc>("skills")
  const row = await skills.get(skillName)
  if (row) await skills.put(skillName, { ...row.doc, category: coordinator, updated_at: Date.now() }, { expectedVersion: row.version })
  hiveOutro(`Skill ${skillName} asignada a ${coordinator}`)
}
