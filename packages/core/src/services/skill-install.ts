/**
 * Installing a skill from a GitHub repository or a local path, into the project's HiveDB.
 *
 *   hivecode skill add https://github.com/vercel-labs/skills --skill find-skills
 *
 * The skill is stored like any other (`skills` collection) but NOT as catalog-managed: the catalog sync
 * removes catalog skills that vanish from its folders, and an installed one has no folder. After the write the
 * skill is indexed for `search_knowledge`, and the result says whether each step held (stored, active, found).
 *
 * Skill text goes into a model's prompt. Installing one is trusting its author, so the result always names
 * the source it came from.
 */
import fs from "node:fs"
import path from "node:path"
import { parseFrontmatter } from "@johpaz/hivecode-skills"
import { col } from "../storage/hive"
import type { SkillDoc } from "../storage/collections"
import { searchCapabilities } from "../agent/capability-search"
import { syncSkillsToIndex } from "../agent/skill-selector"

export type SkillSource =
  | { kind: "github"; owner: string; repo: string; ref?: string; subpath?: string }
  | { kind: "local"; path: string }

export interface FoundSkill {
  /** Folder of the SKILL.md inside the repo or path ("" at the root). */
  dir: string
  content: string
  /** Where it came from, for the record. */
  origin: string
}

export interface InstallDeps {
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const MAX_SKILL_BYTES = 256 * 1024
const MAX_SKILLS_PER_SOURCE = 60
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/
const GITHUB_SSH = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
const SHORTHAND = /^([\w.-]+)\/([\w.-]+)$/

export function parseSkillSource(input: string, exists: (p: string) => boolean = fs.existsSync): SkillSource {
  const text = input.trim()
  const url = GITHUB_URL.exec(text) ?? GITHUB_SSH.exec(text)
  if (url) return { kind: "github", owner: url[1], repo: url[2], ref: url[3], subpath: url[4] }
  // `owner/repo` is a repository only when no such path exists locally.
  const short = SHORTHAND.exec(text)
  if (short && !text.startsWith(".") && !path.isAbsolute(text) && !exists(text)) return { kind: "github", owner: short[1], repo: short[2] }
  return { kind: "local", path: path.resolve(text.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) }
}

const skippedPath = (p: string) => p.split("/").some(part => part.startsWith(".") || part === "node_modules")
const isSkillFile = (p: string) => p === "SKILL.md" || p.endsWith("/SKILL.md")
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")

async function readLimited(response: Response, label: string): Promise<string> {
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error(`${label} pesa más de ${MAX_SKILL_BYTES / 1024} KB`)
  return text
}

/** Every SKILL.md in a GitHub repository (or below `subpath`), hidden folders and node_modules left out. */
export async function discoverGithubSkills(source: Extract<SkillSource, { kind: "github" }>, deps: InstallDeps = {}): Promise<FoundSkill[]> {
  const fetchImpl = deps.fetch ?? fetch
  const env = deps.env ?? process.env
  const ref = source.ref ?? "HEAD"
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "hivecode", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  const where = `${source.owner}/${source.repo}`

  const treeResponse = await fetchImpl(`https://api.github.com/repos/${where}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers })
  if (treeResponse.status === 404) throw new Error(`No encontré ${where}${source.ref ? ` en ${source.ref}` : ""} (¿es privado o el nombre está mal?)`)
  if (treeResponse.status === 403 || treeResponse.status === 429) throw new Error(`GitHub limitó las consultas sin autenticar. Define GITHUB_TOKEN y reintenta.`)
  if (!treeResponse.ok) throw new Error(`GitHub respondió ${treeResponse.status} al listar ${where}`)
  const tree = (await treeResponse.json()) as { tree?: Array<{ path: string; type: string }> }

  const prefix = source.subpath ? `${source.subpath.replace(/\/$/, "")}/` : ""
  const files = (tree.tree ?? [])
    .filter(entry => entry.type === "blob" && isSkillFile(entry.path) && !skippedPath(entry.path) && (!prefix || entry.path.startsWith(prefix) || entry.path === `${prefix}SKILL.md`))
    .map(entry => entry.path)
    .slice(0, MAX_SKILLS_PER_SOURCE)

  const found: FoundSkill[] = []
  for (let i = 0; i < files.length; i += 8) {
    const batch = await Promise.all(files.slice(i, i + 8).map(async file => {
      const raw = await fetchImpl(`https://raw.githubusercontent.com/${where}/${encodeURIComponent(ref)}/${file.split("/").map(encodeURIComponent).join("/")}`, { headers: { "User-Agent": "hivecode" } })
      if (!raw.ok) throw new Error(`No pude descargar ${file} (${raw.status})`)
      return { dir: dirOf(file), content: await readLimited(raw, file), origin: `https://github.com/${where}/blob/${ref}/${file}` }
    }))
    found.push(...batch)
  }
  return found
}

/** Every SKILL.md under a local path, or the file itself when the path is a markdown file. */
export function discoverLocalSkills(root: string): FoundSkill[] {
  const stat = fs.statSync(root)
  if (stat.isFile()) {
    if (stat.size > MAX_SKILL_BYTES) throw new Error(`${root} pesa más de ${MAX_SKILL_BYTES / 1024} KB`)
    // Named after its folder when it is a SKILL.md, after the file otherwise.
    const dir = path.basename(root).toLowerCase() === "skill.md" ? path.basename(path.dirname(root)) : path.basename(root).replace(/\.md$/i, "")
    return [{ dir, content: fs.readFileSync(root, "utf8"), origin: root }]
  }
  const found: FoundSkill[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || found.length >= MAX_SKILLS_PER_SOURCE) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === "SKILL.md" && fs.statSync(full).size <= MAX_SKILL_BYTES) {
        found.push({ dir: path.relative(root, dir).split(path.sep).join("/"), content: fs.readFileSync(full, "utf8"), origin: full })
      }
    }
  }
  walk(root, 0)
  return found
}

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String).map(s => s.trim()).filter(Boolean)
    : typeof value === "string" ? value.split(",").map(s => s.trim()).filter(Boolean) : []

/** A found SKILL.md as a skill document, or the reason it is not one. */
export function toSkillDoc(found: FoundSkill, fallbackAuthor: string, now = Date.now()): { ok: true; doc: SkillDoc } | { ok: false; error: string } {
  const { frontmatter: fm, body } = parseFrontmatter(found.content)
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  const raw = String(fm.name ?? path.basename(found.dir) ?? heading ?? "").trim()
  const name = raw || heading?.replace(/[^A-Za-z0-9._-]+/g, "_") || ""
  if (!SKILL_NAME.test(name)) return { ok: false, error: `${found.origin}: nombre de skill no válido ("${name}"). Usa letras, números, punto, guion o guion bajo.` }
  const text = body.trim()
  if (!text) return { ok: false, error: `${found.origin}: la skill "${name}" no tiene contenido` }
  const version = String(fm.version ?? "0.0.1")
  return {
    ok: true,
    doc: {
      id: name, name, description: typeof fm.description === "string" ? fm.description.trim() : null, version,
      author: String(fm.author ?? fallbackAuthor), icon: String(fm.icon ?? "skill"), category: String(fm.category ?? "custom"),
      permissions: JSON.stringify(asList(fm.permissions)), dependencies: JSON.stringify(asList(fm.dependencies)),
      tools: asList(fm.tools).join(","), triggers: asList(fm.triggers).join(","), preferred_agents: JSON.stringify(asList(fm.preferred_agents)),
      body: text, version_num: Number.parseInt(version, 10) || 1, active: true,
      metadata: JSON.stringify({ installed_from: found.origin, installed_at: new Date(now).toISOString(), frontmatter: fm }),
      source_path: found.origin, catalog_managed: false, created_at: now, updated_at: now,
    },
  }
}

export interface InstallOutcome {
  name: string
  status: "installed" | "updated" | "catalog" | "failed"
  error?: string
  origin?: string
  /** What was checked after the write; absent when it failed. */
  verified?: { stored: boolean; active: boolean; searchable: boolean }
}

/**
 * Stores the skills, indexes them, and checks each one: it is in the collection, active, and `search_knowledge`
 * (type skill) finds it by name.
 */
export async function installSkills(found: FoundSkill[], fallbackAuthor: string): Promise<InstallOutcome[]> {
  const skills = await col<SkillDoc>("skills")
  const outcomes: InstallOutcome[] = []
  const written: string[] = []
  const checked: string[] = []
  for (const item of found) {
    const parsed = toSkillDoc(item, fallbackAuthor)
    if ("error" in parsed) { outcomes.push({ name: path.basename(item.dir) || "(raíz)", status: "failed", error: parsed.error, origin: item.origin }); continue }
    const { doc } = parsed
    const existing = await skills.get(doc.id)
    if (existing?.doc.catalog_managed) {
      // Already loaded from a skills folder (`~/.agents/skills`, `./.agents/skills`, bundled…). The catalog reloads it
      // from there and would overwrite a copy written here, so it is left alone and checked as it stands.
      outcomes.push({ name: doc.name, status: "catalog", origin: existing.doc.source_path ?? "catálogo incluido" })
      checked.push(doc.name)
      continue
    }
    await skills.put(doc.id, { ...doc, created_at: existing?.doc.created_at ?? doc.created_at }, { expectedVersion: existing?.version ?? 0 })
    written.push(doc.id)
    outcomes.push({ name: doc.name, status: existing ? "updated" : "installed", origin: item.origin })
  }
  if (written.length) await syncSkillsToIndex()
  if (written.length || checked.length) {
    for (const outcome of outcomes) {
      if (outcome.status === "failed") continue
      const row = (await skills.get(outcome.name))?.doc
      const hits = await searchCapabilities(outcome.name, { types: ["skill"], k: 10 }).catch(() => [])
      outcome.verified = { stored: !!row, active: row?.active === true, searchable: hits.some(hit => hit.rawId === outcome.name) }
    }
  }
  return outcomes
}

/** Picks the skills the user named (by name or by folder) among the ones found; all of them when none is named and there is one. */
export function selectSkills(found: FoundSkill[], wanted: string[]): { chosen: FoundSkill[]; missing: string[]; available: string[] } {
  const nameOf = (item: FoundSkill) => {
    const fm = parseFrontmatter(item.content).frontmatter
    return String(fm.name ?? path.basename(item.dir) ?? "").trim()
  }
  const available = found.map(nameOf).filter(Boolean).sort()
  if (!wanted.length) return { chosen: found.length === 1 ? found : [], missing: [], available }
  const lower = wanted.map(w => w.toLowerCase())
  const chosen = found.filter(item => lower.includes(nameOf(item).toLowerCase()) || lower.includes(path.basename(item.dir).toLowerCase()))
  const got = new Set(chosen.flatMap(item => [nameOf(item).toLowerCase(), path.basename(item.dir).toLowerCase()]))
  return { chosen, missing: wanted.filter(w => !got.has(w.toLowerCase())), available }
}

/** The whole operation for a source string: discover, choose, install, verify. */
export async function addSkillsFromSource(input: string, options: { skills?: string[]; list?: boolean } = {}, deps: InstallDeps = {}):
  Promise<{ source: SkillSource; available: string[]; outcomes: InstallOutcome[]; missing: string[]; needsChoice: boolean }> {
  const source = parseSkillSource(input)
  const found = source.kind === "github" ? await discoverGithubSkills(source, deps) : discoverLocalSkills(source.path)
  if (!found.length) throw new Error(`No encontré ningún SKILL.md en ${input}`)
  const { chosen, missing, available } = selectSkills(found, options.skills ?? [])
  if (options.list) return { source, available, outcomes: [], missing: [], needsChoice: false }
  if (!chosen.length) return { source, available, outcomes: [], missing, needsChoice: !(options.skills?.length) }
  const author = source.kind === "github" ? source.owner : "local"
  return { source, available, outcomes: await installSkills(chosen, author), missing, needsChoice: false }
}

/** `--skill a --skill b`, `-s a`, `--skill=a`, and `--list`; the first plain argument is the source. */
export function parseSkillAddArgs(args: string[]): { source?: string; skills: string[]; list: boolean } {
  const skills: string[] = []
  let source: string | undefined
  let list = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--list" || arg === "-l") list = true
    else if (arg === "--skill" || arg === "-s") { const value = args[++i]; if (value && !value.startsWith("-")) skills.push(value); else if (value) i-- }
    else if (arg.startsWith("--skill=")) skills.push(arg.slice("--skill=".length))
    else if (!arg.startsWith("-") && !source) source = arg
  }
  return { source, skills: skills.filter(Boolean), list }
}

/** The outcome of `addSkillsFromSource` as plain lines, for surfaces without the CLI's widgets (the TUI). */
export function describeSkillInstall(result: Awaited<ReturnType<typeof addSkillsFromSource>>, listOnly: boolean): string {
  const lines: string[] = []
  if (listOnly || (result.needsChoice && !result.outcomes.length)) {
    lines.push(`  Skills disponibles (${result.available.length}):`, ...result.available.map(name => `    · ${name}`))
    lines.push(listOnly ? "  Instala una con: /skill add <fuente> --skill <nombre>" : "  La fuente tiene varias skills: elige con --skill <nombre>")
    return lines.join("\n")
  }
  if (result.missing.length) lines.push(`  ✗ No encontré: ${result.missing.join(", ")}. Disponibles: ${result.available.join(", ")}`)
  for (const outcome of result.outcomes) {
    if (outcome.status === "failed") { lines.push(`  ✗ ${outcome.name}: ${outcome.error}`); continue }
    const v = outcome.verified
    const ok = !!v && v.stored && v.active && v.searchable
    const label = outcome.status === "installed" ? "instalada" : outcome.status === "updated" ? "actualizada" : "ya estaba cargada desde una carpeta de skills"
    lines.push(`  ${ok ? "✓" : "⚠"} ${outcome.name} (${label}) · base de datos: ${v?.stored ? "sí" : "NO"} · activa: ${v?.active ? "sí" : "NO"} · encontrable: ${v?.searchable ? "sí" : "NO"}`)
    lines.push(`    Origen: ${outcome.origin}`)
  }
  if (result.outcomes.length) lines.push("  El texto de una skill entra en el prompt del agente: instala solo de fuentes en las que confíes.")
  return lines.join("\n")
}
