/**
 * Which project a directory belongs to, and the record that stands for it.
 *
 * The key is the repository, not the folder you happened to open: the project, its subfolders and every
 * `git worktree` of it share the git common dir, so they share one project and one index. Without git the
 * real path is the key.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { col } from "../storage/hive"
import type { CodeProjectDoc, CodeSessionDoc } from "../storage/collections"

export interface ProjectIdentity {
  id: string
  /** Root of the repository (or the folder, without git): the base of every path in the index. */
  root: string
  name: string
}

const identities = new Map<string, ProjectIdentity>()
const toplevels = new Map<string, string>()

const git = (cwd: string, ...args: string[]): string | null => {
  try { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).toString().trim() || null } catch { return null }
}

const realpath = (dir: string): string => { try { return fs.realpathSync(dir) } catch { return path.resolve(dir) } }

/** The top of the checkout `dir` is in: the project root, or the root of one of its worktrees. */
export function checkoutRoot(dir: string): string {
  const real = realpath(dir)
  const hit = toplevels.get(real)
  if (hit) return hit
  const top = git(real, "rev-parse", "--show-toplevel")
  const resolved = top ? realpath(top) : real
  toplevels.set(real, resolved)
  return resolved
}

function nameOf(root: string): string {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name
    if (typeof name === "string" && name.trim()) return name.trim()
  } catch { /* no manifest */ }
  return path.basename(root)
}

export function projectIdentity(dir: string): ProjectIdentity {
  const real = realpath(dir)
  const cached = identities.get(real)
  if (cached) return cached
  let root = checkoutRoot(real)
  const common = git(real, "rev-parse", "--path-format=absolute", "--git-common-dir")
  // The common dir of a worktree lives in the main checkout: its parent is the project root.
  if (common && path.basename(common) === ".git") root = realpath(path.dirname(common))
  const identity = { id: createHash("sha256").update(root).digest("hex").slice(0, 16), root, name: nameOf(root) }
  identities.set(real, identity)
  return identity
}

export function resetProjectIdentityCache(): void { identities.clear(); toplevels.clear() }

/** The project record for a directory, created on first sight and told about every path it is opened from. */
export async function ensureProject(dir: string): Promise<CodeProjectDoc> {
  const identity = projectIdentity(dir)
  const projects = await col<CodeProjectDoc>("codeProjects")
  const existing = await projects.get(identity.id)
  const now = Date.now()
  const here = realpath(dir)
  if (existing) {
    const paths: string[] = JSON.parse(existing.doc.paths || "[]")
    if (paths.includes(here)) return existing.doc
    const next = { ...existing.doc, paths: JSON.stringify([...paths, here]), updated_at: now }
    await projects.put(identity.id, next, { expectedVersion: existing.version }).catch(() => {})
    return next
  }
  const doc: CodeProjectDoc = {
    id: identity.id, name: identity.name, root_path: identity.root, paths: JSON.stringify([...new Set([identity.root, here])]),
    notes: "", indexed_at: null, created_at: now, updated_at: now,
  }
  await projects.put(identity.id, doc, { expectedVersion: 0 }).catch(() => {})
  return (await projects.get(identity.id))?.doc ?? doc
}

/** The project a session works on: its identity comes from where the session was opened. */
export function sessionProject(session: Pick<CodeSessionDoc, "project_path">): ProjectIdentity {
  return projectIdentity(session.project_path)
}

/** Same, from a session id; null when the session does not exist. */
export async function projectOfSession(sessionId: string): Promise<ProjectIdentity | null> {
  const session = (await (await col<CodeSessionDoc>("codeSessions")).get(sessionId))?.doc
  return session ? sessionProject(session) : null
}

/** Ids of every session opened on a project, whichever folder or worktree it was started from. */
export async function sessionsOfProject(projectId: string): Promise<string[]> {
  const sessions = await col<CodeSessionDoc>("codeSessions")
  return (await sessions.scan()).map(entry => entry.doc).filter(session => sessionProject(session).id === projectId).map(session => session.id)
}

/** Max length of the notes: they ride in every agent's context, so they stay short. */
export const MAX_PROJECT_NOTES = 4_000

/**
 * Sets the notes the user wrote for a project; they reach every agent's context from the next call on.
 * Empty text clears them. Returns the stored project.
 */
export async function setProjectNotes(projectId: string, notes: string): Promise<CodeProjectDoc> {
  const text = notes.trim()
  if (text.length > MAX_PROJECT_NOTES) throw new Error(`Las notas pesan ${text.length} caracteres (máximo ${MAX_PROJECT_NOTES}): van en el contexto de cada agente.`)
  const { mutateDoc } = await import("../storage/hive")
  const next = await mutateDoc<CodeProjectDoc>("codeProjects", projectId, current => current && { ...current, notes: text, updated_at: Date.now() })
  if (!next) throw new Error("Proyecto desconocido")
  // The cached summary and every cached packet carry the old notes.
  await (await col("codeContextCache")).delete(`project_context:${projectId}`)
  return next
}
