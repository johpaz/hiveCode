/**
 * Context Retriever — fast code context via SQLite FTS5.
 *
 * - searchCode: keyword search over source files (used by search_knowledge type="code")
 * - getModuleContext: rich context for a single file (content + deps + dependents)
 * - buildProjectContext / getProjectContext: global project summary injected into Bee
 */

import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import * as fs from "node:fs"
import * as path from "node:path"

const log = logger.child("context-retriever")

const CONTEXT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 // 24 hours

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

function buildFtsMatch(words: string[]): string {
  if (words.length > 1) {
    return words.map(w => `${w}*`).join(" AND ")
  }
  return `"${words.join(" ")}" OR ${words[0]}*`
}

/**
 * Search source code via FTS5. Returns matching files with highlighted snippets.
 */
export function searchCode(
  sessionId: string,
  query: string,
  limit = 10,
): CodeSearchResult[] {
  const db = getDb()
  const normalizedQuery = query.replace(/_/g, " ").trim()
  const words = normalizedQuery.split(/\s+/).filter(w => w.length > 0)
  if (words.length === 0) return []

  const ftsMatch = buildFtsMatch(words)

  try {
    const rows = db.query<
      { file_path: string; snippet: string; rank: number },
      [string, string, number]
    >(/* sql */ `
      SELECT
        file_path,
        highlight(code_fts, 2, '<match>', '</match>') AS snippet,
        bm25(code_fts) AS rank
      FROM code_fts
      WHERE session_id = ? AND code_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sessionId, ftsMatch, limit)

    return rows.map(r => ({
      filePath: r.file_path,
      snippet: r.snippet,
      rank: r.rank,
    }))
  } catch (err) {
    log.warn(`[context-retriever] FTS search failed: ${(err as Error).message}`)
    return []
  }
}

/**
 * Get rich context for a single module: its content, deps, dependents, and metadata.
 * Content is truncated to ~8KB to avoid blowing context windows.
 */
export function getModuleContext(
  sessionId: string,
  filePath: string,
): ModuleContext | null {
  const db = getDb()

  const row = db.query<
    {
      imports: string
      exported_by: string
      exports: string
      functions: string
      classes: string
      complexity: number
    },
    [string, string]
  >(/* sql */ `
    SELECT imports, exported_by, exports, functions, classes, complexity
    FROM code_graph
    WHERE session_id = ? AND file_path = ?
  `).get(sessionId, filePath)

  if (!row) return null

  let content = ""
  let contentTruncated = false
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
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
 * Build a global project context summary and cache it in SQLite.
 * Called after buildFullIndex / reconcileCodeIndex.
 */
export function buildProjectContext(sessionId: string, workspace: string): void {
  try {
    const db = getDb()

    // 1. Top-level structure
    const packagesDir = path.join(workspace, "packages")
    const packages: string[] = []
    if (fs.existsSync(packagesDir)) {
      for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const pkgJson = path.join(packagesDir, entry.name, "package.json")
          let desc = entry.name
          if (fs.existsSync(pkgJson)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"))
              if (pkg.description) desc = `${entry.name} — ${pkg.description}`
            } catch { /* ignore */ }
          }
          packages.push(desc)
        }
      }
    }

    // 2. Key files
    const keyFiles = ["package.json", "README.md", "tsconfig.json", ".env.example"]
      .map(f => path.join(workspace, f))
      .filter(f => fs.existsSync(f))
      .map(f => path.relative(workspace, f))

    // 3. Most critical files (highest exported_by count)
    const criticalRows = db.query<
      { file_path: string; exports: string; functions: string; classes: string },
      [string]
    >(/* sql */ `
      SELECT file_path, exports, functions, classes
      FROM code_graph
      WHERE session_id = ?
      ORDER BY length(exported_by) DESC
      LIMIT 10
    `).all(sessionId)

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
    const adrRows = db.query<{ title: string }, [string]>(/* sql */ `
      SELECT title FROM code_decisions
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT 5
    `).all(sessionId)

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

    // 6. Cache it
    const cacheKey = `project_context:${sessionId}`
    const expiresAt = new Date(Date.now() + CONTEXT_CACHE_TTL_MS).toISOString()
    db.query(`
      INSERT OR REPLACE INTO code_context_cache (cache_key, compiled, expires_at)
      VALUES (?, ?, ?)
    `).run(cacheKey, ctx, expiresAt)

    log.info(`[context-retriever] Project context built and cached for ${sessionId}`)
  } catch (err) {
    log.warn(`[context-retriever] Failed to build project context: ${(err as Error).message}`)
  }
}

/**
 * Retrieve cached project context for a session.
 * Returns null if not found or expired.
 */
export function getProjectContext(sessionId: string): string | null {
  try {
    const db = getDb()
    const row = db.query<{ compiled: string }, [string]>(/* sql */ `
      SELECT compiled FROM code_context_cache
      WHERE cache_key = ? AND expires_at > datetime('now')
    `).get(`project_context:${sessionId}`)
    return row?.compiled ?? null
  } catch {
    return null
  }
}
