/**
 * Skill commands — manage Hive-Code skills.
 *
 * hivecode skill list
 * hivecode skill enable <name>
 * hivecode skill disable <name>
 * hivecode skill add <repo-github|url|ruta> [--skill <nombre>]... [--list]
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
import { addSkillsFromSource, parseSkillAddArgs } from "@johpaz/hivecode-core/services/skill-install"
import { syncSkillsToIndex } from "@johpaz/hivecode-core/agent/skill-selector"

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
  await syncSkillsToIndex()
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
  await syncSkillsToIndex()
  hiveOutro(`Skill ${name} deshabilitada`)
}

export async function skillAdd(args: string[] = []): Promise<void> {
  hiveIntro("hivecode · Añadir Skill")
  const parsed = parseSkillAddArgs(args)
  let source = parsed.source
  if (!source) {
    const answer = await hiveText({ message: "Repositorio de GitHub, URL o ruta de la skill:", placeholder: "https://github.com/vercel-labs/skills" })
    if (isCancel(answer) || !answer || typeof answer !== "string") { hiveOutro("Cancelado", "error"); return }
    source = answer
  }

  const spinner = hiveSpinner()
  spinner.start(`Buscando skills en ${source}`)
  try {
    const result = await addSkillsFromSource(source, { skills: parsed.skills, list: parsed.list })
    spinner.stop(`${result.available.length} skill(s) en la fuente`)

    if (parsed.list || (result.needsChoice && !result.outcomes.length)) {
      hiveNote("Skills disponibles", result.available.map(name => `· ${name}`))
      hiveOutro(parsed.list ? "Instala una con: hivecode skill add <fuente> --skill <nombre>" : "La fuente tiene varias skills: elige con --skill <nombre>", parsed.list ? "success" : "error")
      if (!parsed.list) process.exit(1)
      return
    }
    if (result.missing.length) {
      hiveNote("No encontré", result.missing.map(name => `· ${name}`))
      hiveNote("Disponibles", result.available.map(name => `· ${name}`))
    }
    let failed = result.missing.length > 0
    for (const outcome of result.outcomes) {
      if (outcome.status === "failed") { failed = true; hiveNote(`✗ ${outcome.name}`, [outcome.error ?? "error"]); continue }
      const v = outcome.verified
      const ok = !!v && v.stored && v.active && v.searchable
      if (!ok) failed = true
      const label = outcome.status === "installed" ? "instalada" : outcome.status === "updated" ? "actualizada" : "ya estaba cargada desde una carpeta de skills"
      hiveNote(`${ok ? "✓" : "⚠"} ${outcome.name} (${label})`, [
        `Origen: ${outcome.origin}`,
        `En la base de datos: ${v?.stored ? "sí" : "NO"} · activa: ${v?.active ? "sí" : "NO"} · encontrable con search_knowledge: ${v?.searchable ? "sí" : "NO"}`,
        "El texto de una skill entra en el prompt del agente: instala solo de fuentes en las que confíes.",
      ])
    }
    hiveOutro(failed ? "Terminó con problemas" : `${result.outcomes.length} skill(s) cargada(s) en la base de datos`, failed ? "error" : "success")
    if (failed) process.exit(1)
  } catch (err) {
    spinner.stop("No se pudo leer la fuente", "error")
    hiveOutro((err as Error).message, "error")
    process.exit(1)
  }
}

export async function skillRemove(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode skill remove <name>", "error")
    process.exit(1)
  }

  await (await col<SkillDoc>("skills")).delete(name)
  await syncSkillsToIndex()
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
