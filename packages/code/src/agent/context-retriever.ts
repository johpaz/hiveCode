import { buildSnippet } from "@johpaz/hivecode-core/utils/search-snippet";
/**
 * Context Retriever — fast code context via HiveDB capability search.
 *
 * - searchCode: keyword search over source files (used by search_knowledge type="code")
 * - getModuleContext: rich context for a single file (content + deps + dependents)
 * - buildProjectContext / getProjectContext: global project summary injected into Bee
 */

import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeContextCacheDoc, CodeDecisionDoc, CodeFileDoc, CodeGraphDoc, CodeTaskDoc } from "@johpaz/hivecode-core/storage/collections"
import { searchCapabilities } from "@johpaz/hivecode-core/agent/capability-search"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import { sessionsOfProject } from "@johpaz/hivecode-core/agent/project-identity"
import * as fs from "node:fs"
import * as path from "node:path"

const log = logger.child("context-retriever")

const CONTEXT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 // 24 hours

/** In-memory cache for ultra-fast reads (< 0.1ms). Invalidated on rebuild. */
const memProjectCtx = new Map<string, { compiled: string; expiresAt: number; version?: number }>()

export interface CodeSearchResult {
  filePath: string
  snippet: string
  rank: number
}

export interface ModuleContext {
  filePath: string
  content: string
  contentTruncated: boolean
  imports: string[]
  exportedBy: string[]
  exports: string[]
  functions: string[]
  classes: string[]
  complexity: number
}



/**
 * Search source code via HiveDB. Returns matching files with snippets.
 */
export async function searchCode(
  projectId: string,
  root: string,
  query: string,
  limit = 10,
): Promise<CodeSearchResult[]> {
  const normalizedQuery = query.replace(/_/g, " ").trim()
  if (!normalizedQuery) return []

  try {
    const hits = await searchCapabilities(normalizedQuery, {
      types: ["code"],
      filters: [{ field: "project_id", value: projectId }],
      k: limit,
    })
    const codeFiles = await col<CodeFileDoc>("codeFiles")
    const entries = await Promise.all(hits.map(hit => codeFiles.get(hit.rawId)))

    // The index holds symbols, not text: the snippet comes from the file on disk.
    return (await Promise.all(hits.map(async (hit, index) => {
      const doc = entries[index]?.doc
      if (!doc) return null
      const text = await Bun.file(path.join(root, doc.file_path)).text().catch(() => "")
      return { filePath: doc.file_path, snippet: buildSnippet(text, normalizedQuery), rank: hit.score }
    }))).filter((result): result is CodeSearchResult => !!result)
  } catch (err) {
    log.warn(`[context-retriever] HiveDB code search failed: ${(err as Error).message}`)
    return []
  }
}

/**
 * Get rich context for a single module: its content, deps, dependents, and metadata.
 * Content is truncated to ~8KB to avoid blowing context windows.
 */
export async function getModuleContext(
  projectId: string,
  root: string,
  filePath: string,
): Promise<ModuleContext | null> {
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const row = (await codeGraph.findBy("project_id", projectId))
    .map((entry) => entry.doc)
    .find((doc) => doc.file_path === filePath)

  if (!row) return null

  let content = ""
  let contentTruncated = false
  try {
    const raw = await Bun.file(path.join(root, filePath)).text()
    const MAX_LEN = 8192
    if (raw.length > MAX_LEN) {
      content = raw.slice(0, MAX_LEN) + "\n\n... [truncated]"
      contentTruncated = true
    } else {
      content = raw
    }
  } catch (err) {
    log.warn(`[context-retriever] Failed to read ${filePath}: ${(err as Error).message}`)
    content = "[unable to read file]"
  }

  return {
    filePath,
    content,
    contentTruncated,
    imports: JSON.parse(row.imports ?? "[]"),
    exportedBy: JSON.parse(row.exported_by ?? "[]"),
    exports: JSON.parse(row.exports ?? "[]"),
    functions: JSON.parse(row.functions ?? "[]"),
    classes: JSON.parse(row.classes ?? "[]"),
    complexity: row.complexity ?? 0,
  }
}

/**
 * Build a global project context summary and cache it in HiveDB + memory.
 * Called after buildFullIndex / reconcileCodeIndex. Runs async — does NOT block startup.
 */
export async function buildProjectContext(projectId: string, workspace: string): Promise<void> {
  const t0 = performance.now()
  try {
    // 1. Top-level structure
    const packagesDir = path.join(workspace, "packages")
    const packages: string[] = []
    if (fs.existsSync(packagesDir)) {
      for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const pkgJson = path.join(packagesDir, entry.name, "package.json")
          let desc = entry.name
          if (await Bun.file(pkgJson).exists()) {
            try {
              const pkg = JSON.parse(await Bun.file(pkgJson).text())
              if (pkg.description) desc = `${entry.name} — ${pkg.description}`
            } catch { /* ignore */ }
          }
          packages.push(desc)
        }
      }
    }

    // 2. Key files
    const keyFiles: string[] = []
    for (const f of ["package.json", "README.md", "tsconfig.json", ".env.example"]) {
      const fullPath = path.join(workspace, f)
      if (await Bun.file(fullPath).exists()) {
        keyFiles.push(path.relative(workspace, fullPath))
      }
    }

    // 3. Most critical files (highest exported_by count)
    const criticalRows = (await (await col<CodeGraphDoc>("codeGraph")).findBy("project_id", projectId))
      .map((entry) => entry.doc)
      .sort((a, b) => JSON.parse(b.exported_by || "[]").length - JSON.parse(a.exported_by || "[]").length)
      .slice(0, 10)

    const criticalFiles = criticalRows.map(r => {
      const exports = JSON.parse(r.exports ?? "[]") as string[]
      const functions = JSON.parse(r.functions ?? "[]") as string[]
      const classes = JSON.parse(r.classes ?? "[]") as string[]
      const symbols = [...exports, ...functions, ...classes].slice(0, 5)
      return {
        file: r.file_path,
        symbols: symbols.length > 0 ? symbols.join(", ") : "—",
      }
    })

    // 4. Active ADRs
    // Decisions belong to the project: those of the tasks of every session opened on it.
    const tasks = await col<CodeTaskDoc>("codeTasks")
    const projectTaskIds = new Set((await Promise.all((await sessionsOfProject(projectId)).map(id => tasks.findBy("session_id", id)))).flat().map(row => row.doc.id))
    const adrRows = (await (await col<CodeDecisionDoc>("codeDecisions")).findBy("status", "active"))
      .map((entry) => entry.doc)
      .filter(row => row.task_id && projectTaskIds.has(row.task_id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5)

    // 5. Build compact context string
    let ctx = `# PROJECT CONTEXT — ${path.basename(workspace)}\n\n`
    ctx += `## Estructura del proyecto\n`
    if (packages.length > 0) {
      for (const p of packages) ctx += `- ${p}\n`
    } else {
      ctx += `- Monorepo / single package\n`
    }

    ctx += `\n## Archivos clave\n`
    for (const f of keyFiles) ctx += `- ${f}\n`

    ctx += `\n## Módulos más críticos (más importados)\n`
    for (const c of criticalFiles) {
      ctx += `- ${c.file} → ${c.symbols}\n`
    }

    if (adrRows.length > 0) {
      ctx += `\n## Decisiones de arquitectura activas (ADRs)\n`
      for (const adr of adrRows) ctx += `- ${adr.title}\n`
    }

    ctx += `\n## Cómo consultar el código\n`
    ctx += `Para buscar funciones, clases o patrones específicos en el codebase:\n`
    ctx += `search_knowledge(type="code", query="nombreFuncion")\n`
    ctx += `Para descubrir herramientas disponibles:\n`
    ctx += `search_knowledge(type="tools", query="<tarea>")\n`
    ctx += `Para descubrir skills:\n`
    ctx += `search_knowledge(type="skills", query="<tarea>")\n`

    // 6. Cache it — HiveDB + memory
    const cacheKey = `project_context:${projectId}`
    const expiresAt = new Date(Date.now() + CONTEXT_CACHE_TTL_MS).toISOString()
    const cache = await col<CodeContextCacheDoc>("codeContextCache")
    const existing = await cache.get(cacheKey)
    await cache.put(cacheKey, {
      cache_key: cacheKey,
      compiled: ctx,
      expires_at: expiresAt,
      created_at: existing?.doc.created_at ?? new Date().toISOString(),
    }, { expectedVersion: existing?.version ?? 0 })

    memProjectCtx.set(projectId, { compiled: ctx, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS })

    const elapsed = performance.now() - t0
    log.info(`[context-retriever] Project context built and cached for ${projectId} in ${elapsed.toFixed(1)}ms`)
  } catch (err) {
    log.warn(`[context-retriever] Failed to build project context: ${(err as Error).message}`)
  }
}

/**
 * Retrieve cached project context for a session.
 * Memory-first (< 0.1ms). Rebuild callers refresh HiveDB and memory together.
 * Returns null if not found or expired.
 */
export function getProjectContext(projectId: string): string | null {
  const t0 = performance.now()

  // 1. Memory cache — sub-millisecond
  const hit = memProjectCtx.get(projectId)
  if (hit && Date.now() < hit.expiresAt) {
    const elapsed = performance.now() - t0
    if (elapsed > 1) log.debug(`[context-retriever] getProjectContext (memory) took ${elapsed.toFixed(2)}ms`)
    return hit.compiled
  }

  return null
}

/**
 * Like getProjectContext, but validated against the HiveDB row. Works on a
 * fresh process (memory empty) and sees invalidations made by other writers,
 * which makes the first turn independent of the async reconcile finishing.
 */
export async function loadProjectContext(projectId: string): Promise<string | null> {
  try {
    // One keyed get is the source of truth: other writers (agent-loop's
    // refreshSourceIndex) invalidate by deleting this row, and the memory slot
    // would otherwise outlive that for the whole TTL.
    const row = await (await col<CodeContextCacheDoc>("codeContextCache")).get(`project_context:${projectId}`)
    if (!row) {
      memProjectCtx.delete(projectId)
      return null
    }
    const expiresAt = Date.parse(row.doc.expires_at)
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return null
    const mem = memProjectCtx.get(projectId)
    if (mem && mem.version === row.version) return mem.compiled
    memProjectCtx.set(projectId, { compiled: row.doc.compiled, expiresAt, version: row.version })
    return row.doc.compiled
  } catch (err) {
    log.debug(`[context-retriever] loadProjectContext failed: ${(err as Error).message}`)
    return getProjectContext(projectId)
  }
}
