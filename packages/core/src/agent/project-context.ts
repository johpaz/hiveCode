import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { col, ensureIndexes } from "../storage/hive"
import type { CodeSessionDoc, CodeGraphDoc, CodeTaskDoc, CodeDecisionDoc, CodeContextCacheDoc } from "../storage/collections"
import { searchCapabilities } from "./capability-search"
import { budgetTokens, packetSnippetCount } from "./context-budget"

export interface ProjectScopeOptions {
  sessionId?: string
  workspace?: string | null
  taskId?: string
}
export interface ProjectScope { sessionId: string; workspace: string; taskId?: string }
export interface ContextReference {
  kind: "code" | "decision" | "task"
  sessionId: string
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
 * A task that mutates files runs in an isolated `git worktree` of the session's
 * project. Its `.git` is a file ("gitdir: <project>/.git/worktrees/<name>"), which
 * is what proves the directory belongs to that project and not to another one.
 */
async function isWorktreeOf(workspace: string, projectPath: string): Promise<boolean> {
  try {
    const link = (await fs.readFile(path.join(workspace, ".git"), "utf8")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (!link) return false
    const worktrees = path.join(path.resolve(projectPath), ".git", "worktrees") + path.sep
    return path.resolve(workspace, link).startsWith(worktrees)
  } catch {
    return false
  }
}

/** Legacy unscoped calls are safe only when exactly one session is active. */
export async function resolveProjectScope(options: ProjectScopeOptions): Promise<ProjectScope | null> {
  await ensureIndexes([["codeSessions", "status"]])
  const sessions = await col<CodeSessionDoc>("codeSessions")
  const workspace = options.workspace ? path.resolve(options.workspace) : undefined
  let session: CodeSessionDoc | undefined
  if (options.sessionId) {
    session = (await sessions.get(options.sessionId))?.doc
    if (!session) throw new Error(`Unknown project session: ${options.sessionId}`)
    if (workspace && path.resolve(session.project_path) !== workspace && !(await isWorktreeOf(workspace, session.project_path))) {
      throw new Error("Session and workspace do not match")
    }
  } else {
    const candidates = (await sessions.findBy("status", "active")).map(row => row.doc)
      .filter(row => !workspace || path.resolve(row.project_path) === workspace)
    if (candidates.length > 1) throw new Error("Ambiguous project context: provide session_id and workspace")
    session = candidates[0]
  }
  if (!session) return null
  if (options.taskId) {
    const task = (await (await col<CodeTaskDoc>("codeTasks")).get(options.taskId))?.doc
    if (task && task.session_id !== session.id) throw new Error("Task belongs to another project session")
  }
  // Inside an isolated worktree the files to read are the worktree's, not the original project's.
  const root = workspace && workspace !== path.resolve(session.project_path) && await isWorktreeOf(workspace, session.project_path)
    ? workspace
    : path.resolve(session.project_path)
  return { sessionId: session.id, workspace: root, taskId: options.taskId }
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
    if (ref.sessionId !== scope.sessionId) throw new Error("Context reference belongs to another session")
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
export function keyModules(graphs: CodeGraphDoc[], workspace: string, limit = 10): string {
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
      return `- ${path.relative(workspace, graph.file_path)} (${count} importers)${symbols.length ? ` → ${symbols.join(", ")}` : ""}`
    })
    .join("\n")
}

export async function buildContextPacket(scope: ProjectScope, options: {
  query?: string; paths?: string[]; tokenBudget?: number; summaryOnly?: boolean; references?: ContextReference[]
  /** Source files fetched from the query; defaults to what the token budget affords. */
  maxHits?: number
} = {}): Promise<ContextPacket> {
  await ensureIndexes([["codeGraph", "session_id"], ["codeTasks", "session_id"], ["codeDecisions", "status"]])
  const tokenBudget = Math.max(200, Math.min(12_000, Math.floor(options.tokenBudget ?? (options.summaryOnly ? SUMMARY_PACKET_TOKENS : 2600))))
  // codeGraph rows are small and share codeFiles' ids and file_path. Scanning
  // codeFiles here loaded the full source of the whole repo on every turn just
  // to read paths.
  const graphs = (await (await col<CodeGraphDoc>("codeGraph")).findBy("session_id", scope.sessionId)).map(row => row.doc)
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
  append(`# PROJECT CONTEXT · ${path.basename(scope.workspace)}\nSession: ${scope.sessionId}\nWorkspace: ${scope.workspace}`)
  try {
    const rules = await readProjectSource(scope, "AGENTS.md")
    if (!append(`Mandatory project instructions:\n${rules}`, {kind: "code", sessionId: scope.sessionId, id: "AGENTS.md", filePath: "AGENTS.md", hash: fingerprint(rules)}))
      throw new Error("Project instructions exceed context budget; request a larger token_budget")
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  for (const manifest of ["package.json", "Cargo.toml"]) {
    try {
      const raw = await readProjectSource(scope, manifest)
      let summary = raw
      if (manifest === "package.json") {
        const pkg = JSON.parse(raw)
        summary = JSON.stringify({ name: pkg.name, description: pkg.description, scripts: pkg.scripts, workspaces: pkg.workspaces })
      } else summary = raw.split("\n").filter(line => /^(\[|name\s*=|edition\s*=|members\s*=)/.test(line)).join("\n")
      append(`${manifest}\n${summary}`, { kind: "code", sessionId: scope.sessionId, id: `${scope.sessionId}:${manifest}`, filePath: manifest, hash: fingerprint(raw) })
    } catch { /* Not every project has both manifests. */ }
  }
  const packages = [...new Set(files.map(file => path.relative(scope.workspace, file.file_path).split(path.sep).slice(0, 2).join("/")))].slice(0, 12)
  append(`Indexed areas: ${packages.join(", ") || "index unavailable; use scoped filesystem search"}`)
  const modules = keyModules(files, scope.workspace)
  if (modules) append(`Key modules (most imported; read them through search_knowledge type="code" before the disk):\n${modules}`)
  if (scope.taskId) {
    const task = tasks.find(task => task.id === scope.taskId)
    if (task) append(`Task [${task.status}]: ${task.description}`, {kind: "task", sessionId: scope.sessionId, id: task.id, hash: fingerprint(JSON.stringify(task))})
  }
  for (const decision of decisions.filter(row => !scope.taskId || row.task_id === scope.taskId).slice(-5)) {
    append(`Decision: ${decision.title}\n${decision.decision}`, { kind: "decision", sessionId: scope.sessionId, id: decision.id, hash: fingerprint(JSON.stringify(decision)) })
  }
  if (!options.summaryOnly) {
    const selected = new Set((options.paths ?? []).map(p => path.resolve(scope.workspace, p)))
    if (options.query) {
      const hits = await searchCapabilities(options.query, { types: ["code"], filters: [{field: "session_id", value: scope.sessionId}], k: Math.max(1, Math.min(12, options.maxHits ?? packetSnippetCount(tokenBudget))) })
      for (const hit of hits) { const file = files.find(file => file.id === hit.rawId); if (file) selected.add(file.file_path) }
    }
    for (const ref of options.references ?? []) {
      if (ref.sessionId !== scope.sessionId) throw new Error("Context reference belongs to another session")
      if (ref.filePath) selected.add(path.resolve(scope.workspace, ref.filePath))
    }
    for (const absolute of selected) {
      const relative = path.relative(scope.workspace, absolute)
      try {
        const source = await readProjectSource(scope, absolute)
        const lines = source.split("\n")
        const requested = options.references?.find(ref => ref.filePath && path.resolve(scope.workspace, ref.filePath) === absolute)
        const terms = (options.query ?? "").toLowerCase().split(/\W+/).filter(term => term.length > 2)
        const found = lines.findIndex(line => terms.some(term => line.toLowerCase().includes(term)))
        const start = requested?.startLine ?? Math.max(1, found - 5 + 1)
        const end = Math.min(lines.length, requested?.endLine ?? start + 39)
        append(`${relative}:${start}-${end}\n${lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join("\n")}`, {
          kind: "code", sessionId: scope.sessionId, id: `${scope.sessionId}:${absolute}`, filePath: relative,
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
        return {paths: paths.slice(0, 6).map(item => path.isAbsolute(item) ? path.relative(scope.workspace, item) : item), omitted: Math.max(0, paths.length - 6)}
      }
      append(`Related to ${path.relative(scope.workspace, file)}: ${JSON.stringify({imports: compactPaths(graph.imports), dependents: compactPaths(graph.exported_by)})}`)
    }
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
