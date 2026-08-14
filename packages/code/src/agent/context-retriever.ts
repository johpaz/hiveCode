/**
 * Context Retriever — fast code context via HiveDB capability search.
 *
 * - searchCode: keyword search over source files (used by search_knowledge type="code")
 * - getModuleContext: rich context for a single file (content + deps + dependents)
 * - buildProjectContext / getProjectContext: global project summary injected into Bee
 */

import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeContextCacheDoc, CodeDecisionDoc, CodeFileDoc, CodeGraphDoc } from "@johpaz/hivecode-core/storage/collections"
import { searchCapabilities } from "@johpaz/hivecode-core/agent/capability-search"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import * as fs from "node:fs"
import * as path from "node:path"

const log = logger.child("context-retriever")

const CONTEXT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 // 24 hours

/** In-memory cache for ultra-fast reads (< 0.1ms). Invalidated on rebuild. */
let _memProjectCtx: { sessionId: string; compiled: string; expiresAt: number } | null = null

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

function buildSnippet(content: string, query: string, maxLen = 420): string {
  const terms = query
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  const lower = content.toLowerCase()
  let idx = -1
  for (const term of terms) {
    idx = lower.indexOf(term)
    if (idx !== -1) break
  }

  if (idx === -1) return content.slice(0, maxLen)

  const start = Math.max(0, idx - Math.floor(maxLen / 2))
  const end = Math.min(content.length, start + maxLen)
  return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`
}

/**
 * Search source code via HiveDB. Returns matching files with snippets.
 */
export async function searchCode(
  sessionId: string,
  query: string,
  limit = 10,
): Promise<CodeSearchResult[]> {
  const normalizedQuery = query.replace(/_/g, " ").trim()
  if (!normalizedQuery) return []

  try {
    const hits = await searchCapabilities(normalizedQuery, {
      types: ["code"],
      filters: [{ field: "session_id", value: sessionId }],
      k: limit,
    })
    const codeFiles = await col<CodeFileDoc>("codeFiles")
    const entries = await Promise.all(hits.map(hit => codeFiles.get(hit.rawId)))

    return hits.flatMap((hit, index) => {
      const doc = entries[index]?.doc
      if (!doc) return []
      return [{
        filePath: doc.file_path,
        snippet: buildSnippet(doc.content, normalizedQuery),
        rank: hit.score,
      }]
    })
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
  sessionId: string,
  filePath: string,
): Promise<ModuleContext | null> {
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const row = (await codeGraph.findBy("session_id", sessionId))
    .map((entry) => entry.doc)
    .find((doc) => doc.file_path === filePath)

  if (!row) return null

  let content = ""
  let contentTruncated = false
  try {
    const raw = await Bun.file(filePath).text()
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
export async function buildProjectContext(sessionId: string, workspace: string): Promise<void> {
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
    const criticalRows = (await (await col<CodeGraphDoc>("codeGraph")).findBy("session_id", sessionId))
      .map((entry) => entry.doc)
      .sort((a, b) => b.exported_by.length - a.exported_by.length)
      .slice(0, 10)

    const criticalFiles = criticalRows.map(r => {
      const exports = JSON.parse(r.exports ?? "[]") as string[]
      const functions = JSON.parse(r.functions ?? "[]") as string[]
      const classes = JSON.parse(r.classes ?? "[]") as string[]
      const symbols = [...exports, ...functions, ...classes].slice(0, 5)
      return {
        file: path.relative(workspace, r.file_path),
        symbols: symbols.length > 0 ? symbols.join(", ") : "—",
      }
    })

    // 4. Active ADRs
    const adrRows = (await (await col<CodeDecisionDoc>("codeDecisions")).findBy("status", "active"))
      .map((entry) => entry.doc)
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
    const cacheKey = `project_context:${sessionId}`
    const expiresAt = new Date(Date.now() + CONTEXT_CACHE_TTL_MS).toISOString()
    const cache = await col<CodeContextCacheDoc>("codeContextCache")
    const existing = await cache.get(cacheKey)
    await cache.put(cacheKey, {
      cache_key: cacheKey,
      compiled: ctx,
      expires_at: expiresAt,
      created_at: existing?.doc.created_at ?? new Date().toISOString(),
    }, { expectedVersion: existing?.version ?? 0 })

    _memProjectCtx = { sessionId, compiled: ctx, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS }

    const elapsed = performance.now() - t0
    log.info(`[context-retriever] Project context built and cached for ${sessionId} in ${elapsed.toFixed(1)}ms`)
  } catch (err) {
    log.warn(`[context-retriever] Failed to build project context: ${(err as Error).message}`)
  }
}

/**
 * Retrieve cached project context for a session.
 * Memory-first (< 0.1ms). Rebuild callers refresh HiveDB and memory together.
 * Returns null if not found or expired.
 */
export function getProjectContext(sessionId: string): string | null {
  const t0 = performance.now()

  // 1. Memory cache — sub-millisecond
  if (_memProjectCtx && _memProjectCtx.sessionId === sessionId && Date.now() < _memProjectCtx.expiresAt) {
    const elapsed = performance.now() - t0
    if (elapsed > 1) log.debug(`[context-retriever] getProjectContext (memory) took ${elapsed.toFixed(2)}ms`)
    return _memProjectCtx.compiled
  }

  return null
}
