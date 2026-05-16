/**
 * Code Indexer — builds and maintains the code_graph dependency table.
 *
 * - Full index: called at `hive-code init`, scans all code files via Bun.Glob
 * - Incremental: called after each fs_edit / fs_write to update affected files only
 *
 * Uses Bun.Transpiler for lightweight AST analysis (no tsc needed).
 */

import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import * as path from "node:path"
import * as fs from "node:fs"

const log = logger.child("code-indexer")

const CODE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "target"])

interface FileIndex {
  filePath: string
  imports: string[]
  exports: string[]
  functions: string[]
  classes: string[]
  complexity: number
  lastModified: string
}

async function indexFile(filePath: string, workspace: string): Promise<FileIndex | null> {
  try {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return null

    const source = await file.text()
    const stat = fs.statSync(filePath)
    const lastModified = stat.mtime.toISOString()

    const ext = filePath.split(".").pop() ?? "ts"
    const loader = (ext === "tsx" || ext === "jsx") ? "tsx" : "ts"

    const transpiler = new Bun.Transpiler({ loader: loader as any })

    // Extract imports and exports via scanner
    let imports: string[] = []
    let exports: string[] = []
    try {
      const scan = transpiler.scan(source)
      // Resolve relative imports to absolute paths
      imports = (scan.imports ?? [])
        .map((i: any) => i.path)
        .filter((p: string) => p.startsWith("."))
        .map((rel: string) => {
          const resolved = path.resolve(path.dirname(filePath), rel)
          // Try with extensions
          for (const ext of CODE_EXTENSIONS) {
            const candidate = `${resolved}.${ext}`
            if (fs.existsSync(candidate)) return candidate
            const indexCandidate = path.join(resolved, `index.${ext}`)
            if (fs.existsSync(indexCandidate)) return indexCandidate
          }
          return resolved
        })
        .filter(Boolean)

      exports = (scan.exports ?? []).map((e: any) => e.original ?? e).filter(Boolean)
    } catch {
      // Scanner failed — use regex fallback
      const importMatches = source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)
      for (const m of importMatches) {
        const resolved = path.resolve(path.dirname(filePath), m[1])
        imports.push(resolved)
      }
    }

    // Function and class names via regex
    const functions = [...source.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)]
      .map(m => m[1])
    const classes = [...source.matchAll(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g)]
      .map(m => m[1])

    // Cyclomatic complexity estimate
    const complexity = 1 +
      (source.match(/\bif\s*\(/g) ?? []).length +
      (source.match(/\bswitch\s*\(/g) ?? []).length +
      (source.match(/\bfor\s*\(/g) ?? []).length +
      (source.match(/\bwhile\s*\(/g) ?? []).length +
      (source.match(/\bcatch\s*\(/g) ?? []).length +
      (source.match(/\?\s+/g) ?? []).length

    return { filePath, imports, exports, functions, classes, complexity, lastModified }
  } catch (err) {
    log.warn(`[code-indexer] Failed to index ${filePath}: ${(err as Error).message}`)
    return null
  }
}

function upsertFileIndex(sessionId: string, index: FileIndex): void {
  const db = getDb()
  db.query(`
    INSERT OR REPLACE INTO code_graph
      (session_id, file_path, imports, exports, functions, classes, complexity, last_modified, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  `).run(
    sessionId,
    index.filePath,
    JSON.stringify(index.imports),
    JSON.stringify(index.exports),
    JSON.stringify(index.functions),
    JSON.stringify(index.classes),
    index.complexity,
    index.lastModified,
  )
}

function buildExportedByIndex(sessionId: string): void {
  const db = getDb()
  const rows = db.query<any, [string]>(
    "SELECT file_path, imports FROM code_graph WHERE session_id = ?"
  ).all(sessionId)

  // Build reverse map: for each file, who imports it?
  const importedBy = new Map<string, string[]>()
  for (const row of rows) {
    const imports: string[] = JSON.parse(row.imports ?? "[]")
    for (const dep of imports) {
      if (!importedBy.has(dep)) importedBy.set(dep, [])
      importedBy.get(dep)!.push(row.file_path)
    }
  }

  // Update exported_by for all files in batch
  for (const [filePath, importers] of importedBy.entries()) {
    db.query(
      "UPDATE code_graph SET exported_by = ? WHERE session_id = ? AND file_path = ?"
    ).run(JSON.stringify(importers), sessionId, filePath)
  }
}

/**
 * Full index: scan all code files in workspace and populate code_graph.
 * Called at `hive-code init`.
 */
export async function buildFullIndex(sessionId: string, workspace: string): Promise<{
  indexed: number
  skipped: number
  durationMs: number
}> {
  const t0 = performance.now()
  log.info(`[code-indexer] Building full index for session ${sessionId} in ${workspace}`)

  const glob = new Bun.Glob(`**/*.{${CODE_EXTENSIONS.join(",")}}`)
  const files: string[] = []

  for await (const relPath of glob.scan({ cwd: workspace, onlyFiles: true })) {
    // Skip ignored dirs
    const parts = relPath.split(path.sep)
    if (parts.some(p => SKIP_DIRS.has(p))) continue
    files.push(path.resolve(workspace, relPath))
  }

  log.info(`[code-indexer] Found ${files.length} files to index`)

  let indexed = 0
  let skipped = 0

  // Index in batches of 50 to avoid blocking
  const BATCH = 50
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(f => indexFile(f, workspace)))
    const db = getDb()
    // Use transaction for batch writes
    db.transaction(() => {
      for (const result of results) {
        if (result) {
          upsertFileIndex(sessionId, result)
          indexed++
        } else {
          skipped++
        }
      }
    })()
  }

  // Build reverse dependency map
  buildExportedByIndex(sessionId)

  const durationMs = Math.round(performance.now() - t0)
  log.info(`[code-indexer] Full index complete: ${indexed} indexed, ${skipped} skipped in ${durationMs}ms`)

  return { indexed, skipped, durationMs }
}

/**
 * Incremental update: re-index a single file after it's been edited.
 * Called after each fs_edit / fs_write.
 */
export async function updateFileIndex(sessionId: string, filePath: string, workspace: string): Promise<void> {
  const result = await indexFile(filePath, workspace)
  if (!result) return

  upsertFileIndex(sessionId, result)
  buildExportedByIndex(sessionId)
  log.info(`[code-indexer] Updated index for ${path.relative(workspace, filePath)}`)
}

/**
 * Query: who imports this file? Returns file paths that depend on it.
 */
export function getDependents(sessionId: string, filePath: string): string[] {
  const db = getDb()
  const row = db.query<any, [string, string]>(
    "SELECT exported_by FROM code_graph WHERE session_id = ? AND file_path = ?"
  ).get(sessionId, filePath)
  if (!row) return []
  return JSON.parse(row.exported_by ?? "[]")
}

/**
 * Query: what does this file import? Returns file paths it depends on.
 */
export function getDependencies(sessionId: string, filePath: string): string[] {
  const db = getDb()
  const row = db.query<any, [string, string]>(
    "SELECT imports FROM code_graph WHERE session_id = ? AND file_path = ?"
  ).get(sessionId, filePath)
  if (!row) return []
  return JSON.parse(row.imports ?? "[]")
}

/**
 * Query: most imported files (highest centrality = most critical).
 */
export function getMostCriticalFiles(sessionId: string, limit = 20): Array<{
  filePath: string
  importCount: number
  complexity: number
}> {
  const db = getDb()
  const rows = db.query<any, [string]>(
    "SELECT file_path, exported_by, complexity FROM code_graph WHERE session_id = ? ORDER BY length(exported_by) DESC LIMIT 50"
  ).all(sessionId)

  return rows
    .map((r: any) => ({
      filePath: r.file_path,
      importCount: (JSON.parse(r.exported_by ?? "[]") as string[]).length,
      complexity: r.complexity ?? 0,
    }))
    .sort((a, b) => b.importCount - a.importCount)
    .slice(0, limit)
}
