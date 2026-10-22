import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { col, ensureIndexes } from "../storage/hive"
import type { CodeSessionDoc, CodeGraphDoc, CodeProjectDoc, CodeTaskDoc, CodeDecisionDoc, CodeContextCacheDoc } from "../storage/collections"
import { searchCapabilities } from "./capability-search"
import { budgetTokens, packetSnippetCount } from "./context-budget"
import { checkoutRoot, projectIdentity, sessionProject, sessionsOfProject } from "./project-identity"

export interface ProjectScopeOptions {
  sessionId?: string
  workspace?: string | null
  taskId?: string
}
export interface ProjectScope {
  /** The code project: the key of everything indexed. Shared by every session and worktree of it. */
  projectId: string
  /** The session asking; tasks, decisions and turns still belong to it. */
  sessionId: string
  /** Where files are read from: the project root, or the worktree the task runs in. */
  workspace: string
  /** The project root: every path in the index is relative to it. */
  root: string
  taskId?: string
}
export interface ContextReference {
  kind: "code" | "decision" | "task"
  projectId: string
  id: string
  filePath?: string
  startLine?: number
  endLine?: number
  hash: string
}
export interface ContextPacket {
  context: string
  references: ContextReference[]
  version: string
  estimatedTokens: number
  omitted: string[]
  scope: ProjectScope
  cached: boolean
}
export const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex")

/**
 * The session and project a call is about. Without a session id, a call is safe only when the active sessions
 * all belong to one project (several sessions of the same project are fine: they share its index).
 */
export async function resolveProjectScope(options: ProjectScopeOptions): Promise<ProjectScope | null> {
  await ensureIndexes([["codeSessions", "status"]])
  const sessions = await col<CodeSessionDoc>("codeSessions")
  const workspace = options.workspace ? path.resolve(options.workspace) : undefined
  let session: CodeSessionDoc | undefined
  if (options.sessionId) {
    session = (await sessions.get(options.sessionId))?.doc
    if (!session) throw new Error(`Unknown project session: ${options.sessionId}`)
    if (workspace && projectIdentity(workspace).id !== sessionProject(session).id) throw new Error("Session and workspace do not match")
  } else {
    const wanted = workspace ? projectIdentity(workspace).id : undefined
    const candidates = (await sessions.findBy("status", "active")).map(row => row.doc)
      .filter(row => !wanted || sessionProject(row).id === wanted)
      .sort((a, b) => b.last_active.localeCompare(a.last_active))
    if (new Set(candidates.map(row => sessionProject(row).id)).size > 1) throw new Error("Ambiguous project context: provide session_id and workspace")
    session = candidates[0]
  }
  if (!session) return null
  if (options.taskId) {
    const task = (await (await col<CodeTaskDoc>("codeTasks")).get(options.taskId))?.doc
    if (task && task.session_id !== session.id) throw new Error("Task belongs to another project session")
  }
  const project = sessionProject(session)
  // Inside an isolated worktree the files to read are the worktree's, not the original project's.
  const inWorktree = !!workspace && checkoutRoot(workspace) !== project.root
  return { projectId: project.id, sessionId: session.id, workspace: inWorktree ? checkoutRoot(workspace) : project.root, root: project.root, taskId: options.taskId }
}

export function scopeFromConfig(params: Record<string, unknown>, config?: any): ProjectScopeOptions {
  const c = config?.configurable ?? {}
  // Runtime identity wins over model-supplied identifiers.
  return {
    sessionId: c.code_session_id ?? (typeof params.session_id === "string" ? params.session_id : undefined),
    workspace: c.workspace ?? (typeof params.workspace === "string" ? params.workspace : undefined),
    taskId: c.code_task_id ?? (typeof params.task_id === "string" ? params.task_id : undefined),
  }
}

export async function readProjectSource(scope: ProjectScope, filePath: string): Promise<string> {
  const root = await fs.realpath(scope.workspace)
  const requested = path.resolve(root, filePath)
  const relative = path.relative(root, requested)
  if (/^(?:credentials|secrets)\.(?:json|toml)$/i.test(path.basename(requested)) || relative.split(path.sep).some(part => ["node_modules", ".git", "target", "dist", "secrets", ".aws", ".ssh"].includes(part)) || relative.startsWith("..") || path.isAbsolute(relative) || /(^|[/\\])(?:\.env(?:\..*)?|.*\.(?:pem|key))$/.test(relative)) {
    throw new Error("Source is outside the workspace or contains secrets")
  }
  const real = await fs.realpath(requested)
  const rel = path.relative(root, real)
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Source symlink escapes workspace")
  const stat = await fs.stat(real)
  if (!stat.isFile() || stat.size > 1_000_000) throw new Error("Source is not a readable text file under 1 MB")
  const content = await fs.readFile(real, "utf8")
  if (content.includes("\0")) throw new Error("Binary source excluded")
  return content
}

/** Read a reference against disk, detecting uncommitted edits and deleted files. */
export async function resolveContextReferences(scope: ProjectScope, refs: ContextReference[]): Promise<string[]> {
  const result: string[] = []
  for (const ref of refs) {
    if (ref.projectId !== scope.projectId) throw new Error("Context reference belongs to another project")
    if (ref.kind === "task") {
      const task = (await (await col<CodeTaskDoc>("codeTasks")).get(ref.id))?.doc
      if (!task || task.session_id !== scope.sessionId) throw new Error("Task reference is outside project")
      if (fingerprint(JSON.stringify(task)) !== ref.hash) throw new Error("Stale task reference; request fresh context")
      result.push(`Task [${task.status}]: ${task.description}`)
      continue
    }
    if (ref.kind === "decision") {
      const decision = (await (await col<CodeDecisionDoc>("codeDecisions")).get(ref.id))?.doc
      const task = decision?.task_id ? (await (await col<CodeTaskDoc>("codeTasks")).get(decision.task_id))?.doc : null
      if (!decision || task?.session_id !== scope.sessionId) throw new Error("Decision reference is outside project")
      if (fingerprint(JSON.stringify(decision)) !== ref.hash) throw new Error("Stale decision reference; request fresh context")
      result.push(`${decision.title}: ${decision.decision}`)
      continue
    }
    if (ref.kind !== "code" || !ref.filePath) throw new Error("Unknown context reference")
    const source = await readProjectSource(scope, ref.filePath)
    if (fingerprint(source) !== ref.hash) throw new Error(`Stale context reference: ${ref.filePath}; request fresh context`)
    const start = Math.max(1, ref.startLine ?? 1)
    const end = Math.max(start, ref.endLine ?? start + 39)
    if (!Number.isInteger(start) || !Number.isInteger(end) || end - start > 2000) throw new Error("Invalid context range; request targeted context")
    result.push(`${ref.filePath}:${start}-${end}\n${source.split("\n").slice(start - 1, end).join("\n")}`)
  }
  return result
}

/** Default size of the project map when `get_project_context` is called without a budget. */
const SUMMARY_PACKET_TOKENS = 1500

/** The files the rest of the project leans on most, each with a few of its exports: a map the index can answer from. */
export function keyModules(graphs: CodeGraphDoc[], limit = 10): string {
  const importers = (graph: CodeGraphDoc): number => {
    try { return (JSON.parse(graph.exported_by || "[]") as unknown[]).length } catch { return 0 }
  }
  const names = (raw: string | null | undefined): string[] => {
    try { return JSON.parse(raw || "[]") as string[] } catch { return [] }
  }
  return graphs
    .map(graph => ({ graph, count: importers(graph) }))
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.graph.file_path.localeCompare(b.graph.file_path))
    .slice(0, limit)
    .map(({ graph, count }) => {
      const symbols = [...new Set([...names(graph.exports), ...names(graph.functions), ...names(graph.classes)])].slice(0, 5)
      return `- ${graph.file_path} (${count} importers)${symbols.length ? ` → ${symbols.join(", ")}` : ""}`
    })
    .join("\n")
}

/**
 * The files of the areas a task names. Whoever writes the task (the user, or BEE briefing a worker) usually says
 * where to look ("revisa packages/core/src/harness"); the index knows what lives there, and a few lines of
 * symbols per file say it better than a text search that has to guess it from the wording of the task.
 */
export function mentionedAreas(text: string, graphs: CodeGraphDoc[], perArea = 12, maxAreas = 3): string {
  const tokens = [...new Set((text.match(/(?:[\w.@-]+\/)+[\w.-]*/g) ?? []).map(t => t.replace(/[.,;:)]+$/, "").replace(/^\.\//, "")))]
    .filter(t => t.includes("/")).slice(0, maxAreas)
  const names = (raw: string | null | undefined): string[] => { try { return JSON.parse(raw || "[]") } catch { return [] } }
  const count = (g: CodeGraphDoc) => names(g.exported_by).length
  const blocks: string[] = []
  for (const token of tokens) {
    const dir = token.endsWith("/") ? token : `${token}/`
    const files = graphs.filter(g => g.file_path === token || g.file_path.startsWith(dir) || g.file_path.includes(`/${dir}`))
      .sort((a, b) => count(b) - count(a) || a.file_path.localeCompare(b.file_path))
    if (!files.length) continue
    const lines = files.slice(0, perArea).map(g => {
      const symbols = [...new Set([...names(g.exports), ...names(g.functions), ...names(g.classes)])].slice(0, 4)
      return `- ${g.file_path}${count(g) ? ` (${count(g)} importers)` : ""}${symbols.length ? ` → ${symbols.join(", ")}` : ""}`
    })
    blocks.push(`${token} — ${files.length} file(s)${files.length > perArea ? `, the ${perArea} most imported` : ""}:\n${lines.join("\n")}`)
  }
  return blocks.join("\n")
}

export async function buildContextPacket(scope: ProjectScope, options: {
  query?: string; paths?: string[]; tokenBudget?: number; summaryOnly?: boolean; references?: ContextReference[]
  /** Source files fetched from the query; defaults to what the token budget affords. */
  maxHits?: number
} = {}): Promise<ContextPacket> {
  await ensureIndexes([["codeGraph", "project_id"], ["codeTasks", "session_id"], ["codeDecisions", "status"]])
  const tokenBudget = Math.max(200, Math.min(12_000, Math.floor(options.tokenBudget ?? (options.summaryOnly ? SUMMARY_PACKET_TOKENS : 2600))))
  // codeGraph rows are small; the index holds no file text, so this never loads the source of the repo.
  const graphs = (await (await col<CodeGraphDoc>("codeGraph")).findBy("project_id", scope.projectId)).map(row => row.doc)
  const files = graphs
  const tasks = (await (await col<CodeTaskDoc>("codeTasks")).findBy("session_id", scope.sessionId)).map(row => row.doc)
  const taskIds = new Set(tasks.map(task => task.id))
  const decisions = (await (await col<CodeDecisionDoc>("codeDecisions")).findBy("status", "active"))
    .map(row => row.doc).filter(row => row.task_id && taskIds.has(row.task_id))
  const sections: string[] = []
  const references: ContextReference[] = []
  const omitted: string[] = []
  const append = (text: string, ref?: ContextReference): boolean => {
    if (budgetTokens([...sections, text].join("\n\n")) + budgetTokens(JSON.stringify(ref ? [...references, ref] : references)) > tokenBudget) { omitted.push(ref?.filePath ?? ref?.id ?? "project section"); return false }
    sections.push(text)
    if (ref) references.push(ref)
    return true
  }
  append(`# PROJECT CONTEXT · ${(await (await col<CodeProjectDoc>("codeProjects")).get(scope.projectId))?.doc.name ?? path.basename(scope.root)}\nSession: ${scope.sessionId}\nWorkspace: ${scope.workspace}`)
  try {
    const rules = await readProjectSource(scope, "AGENTS.md")
    if (!append(`Mandatory project instructions:\n${rules}`, {kind: "code", projectId: scope.projectId, id: "AGENTS.md", filePath: "AGENTS.md", hash: fingerprint(rules)}))
      throw new Error("Project instructions exceed context budget; request a larger token_budget")
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const notes = (await (await col<CodeProjectDoc>("codeProjects")).get(scope.projectId))?.doc.notes?.trim()
  if (notes) append(`Project notes (written by the user):\n${notes}`)
  if (scope.taskId) {
    const task = tasks.find(task => task.id === scope.taskId)
    if (task) append(`Task [${task.status}]: ${task.description}`, {kind: "task", projectId: scope.projectId, id: task.id, hash: fingerprint(JSON.stringify(task))})
  }
  for (const decision of decisions.filter(row => !scope.taskId || row.task_id === scope.taskId).slice(-5)) {
    append(`Decision: ${decision.title}\n${decision.decision}`, { kind: "decision", projectId: scope.projectId, id: decision.id, hash: fingerprint(JSON.stringify(decision)) })
  }

  /** The map of the project: what it is and where things live. Last for a task (evidence first), first for the coordinator. */
  const appendOverview = async () => {
    for (const manifest of ["package.json", "Cargo.toml"]) {
      try {
        const raw = await readProjectSource(scope, manifest)
        let summary = raw
        if (manifest === "package.json") {
          const pkg = JSON.parse(raw)
          // Script names, not their commands: the commands are a file read away and cost more than they tell.
          summary = JSON.stringify({ name: pkg.name, description: pkg.description, scripts: pkg.scripts ? Object.keys(pkg.scripts) : undefined, workspaces: pkg.workspaces })
        } else summary = raw.split("\n").filter(line => /^(\[|name\s*=|edition\s*=|members\s*=)/.test(line)).join("\n")
        append(`${manifest}\n${summary}`, { kind: "code", projectId: scope.projectId, id: `${scope.projectId}:${manifest}`, filePath: manifest, hash: fingerprint(raw) })
      } catch { /* Not every project has both manifests. */ }
    }
    const packages = [...new Set(files.map(file => file.file_path.split(path.sep).slice(0, 2).join("/")))].slice(0, 12)
    append(`Indexed areas: ${packages.join(", ") || "index unavailable; use scoped filesystem search"}`)
    // The most-imported modules are the coordinator's map; a worker's budget goes to the evidence of its task.
    const modules = options.summaryOnly ? keyModules(files) : ""
    if (modules) append(`Key modules (most imported; read them through search_knowledge type="code" before the disk):\n${modules}`)
  }
  if (options.summaryOnly) await appendOverview()

  if (!options.summaryOnly) {
    // Index paths are relative to the root; a worktree has the same layout, so the same relative path reads there.
    const toRelative = (p: string) => path.relative(scope.workspace, path.resolve(scope.workspace, p))
    const selected = new Set((options.paths ?? []).map(toRelative))
    const areas = mentionedAreas(options.query ?? "", graphs)
    if (areas) append(`Areas named by the task (read them through outline / find_symbol, then fs_read by range):\n${areas}`)
    // A task that names its areas has said where to look; a text search over symbol names would only add guesses.
    // Without named areas the search is the only lead, and a few ranges are all it earns.
    const searchHits = areas ? 0 : Math.min(options.maxHits ?? packetSnippetCount(tokenBudget), 3)
    if (options.query && searchHits > 0) {
      const hits = await searchCapabilities(options.query, { types: ["code"], filters: [{field: "project_id", value: scope.projectId}], k: searchHits })
      for (const hit of hits) { const file = files.find(file => file.id === hit.rawId); if (file) selected.add(file.file_path) }
    }
    for (const ref of options.references ?? []) {
      if (ref.projectId !== scope.projectId) throw new Error("Context reference belongs to another project")
      if (ref.filePath) selected.add(toRelative(ref.filePath))
    }
    for (const relative of selected) {
      try {
        const source = await readProjectSource(scope, relative)
        const lines = source.split("\n")
        const requested = options.references?.find(ref => ref.filePath && toRelative(ref.filePath) === relative)
        const terms = (options.query ?? "").toLowerCase().split(/\W+/).filter(term => term.length > 2)
        const found = lines.findIndex(line => terms.some(term => line.toLowerCase().includes(term)))
        const start = requested?.startLine ?? Math.max(1, found - 5 + 1)
        const end = Math.min(lines.length, requested?.endLine ?? start + 39)
        append(`${relative}:${start}-${end}\n${lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join("\n")}`, {
          kind: "code", projectId: scope.projectId, id: `${scope.projectId}:${relative}`, filePath: relative,
          startLine: start, endLine: end, hash: fingerprint(source),
        })
      } catch (error) { omitted.push(`${relative}: ${(error as Error).message}`) }
    }
    // Source evidence takes precedence over bounded one-hop navigation metadata.
    for (const file of selected) {
      const graph = graphs.find(row => row.file_path === file)
      if (!graph) continue
      const compactPaths = (raw: string) => {
        const paths: string[] = JSON.parse(raw || "[]")
        return {paths: paths.slice(0, 6), omitted: Math.max(0, paths.length - 6)}
      }
      const imports = compactPaths(graph.imports)
      const dependents = compactPaths(graph.exported_by)
      // A line that says "no imports, no dependents" is worth nothing.
      if (imports.paths.length || dependents.paths.length) append(`Related to ${file}: ${JSON.stringify({imports, dependents})}`)
    }
    await appendOverview()
  }
  const context = sections.join("\n\n")
  const version = fingerprint(JSON.stringify({ context, references, omitted }))
  const packet: ContextPacket = { context, references, version, estimatedTokens: budgetTokens(context) + budgetTokens(JSON.stringify(references)), omitted, scope, cached: false }
  const key = `task_context:${fingerprint(JSON.stringify({scope, options}))}`
  const cache = await col<CodeContextCacheDoc>("codeContextCache")
  const previous = await cache.get(key)
  if (previous?.doc.compiled) {
    try { if (JSON.parse(previous.doc.compiled).version === version) return {...packet, cached: true} } catch { /* legacy row */ }
  }
  await cache.put(key, { cache_key: key, compiled: JSON.stringify(packet), expires_at: new Date(Date.now() + 86400000).toISOString(), created_at: previous?.doc.created_at ?? new Date().toISOString() }, { expectedVersion: previous?.version ?? 0 })
  return packet
}
