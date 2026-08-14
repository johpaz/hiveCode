/**
 * Code Indexer — builds and maintains the HiveDB code graph.
 *
 * - Full index: called at `hive-code init`, scans all code files via Bun.Glob
 * - Incremental: called after each fs_edit / fs_write to update affected files only
 *
 * Uses Bun.Transpiler for lightweight AST analysis (no tsc needed).
 */

import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeFileDoc, CodeGraphDoc, CodeSessionDoc } from "@johpaz/hivecode-core/storage/collections"
import {
  upsertCapabilityDocs,
  deleteCapabilitiesByFilter,
} from "@johpaz/hivecode-core/agent/capability-search"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import * as path from "node:path"
import * as fs from "node:fs"
import { buildProjectContext } from "./context-retriever"

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
  content: string
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
      const importPromises = (scan.imports ?? [])
        .map((i: any) => i.path)
        .filter((p: string) => p.startsWith("."))
        .map(async (rel: string) => {
          const resolved = path.resolve(path.dirname(filePath), rel)
          // Try with extensions
          for (const ext of CODE_EXTENSIONS) {
            const candidate = `${resolved}.${ext}`
            if (await Bun.file(candidate).exists()) return candidate
            const indexCandidate = path.join(resolved, `index.${ext}`)
            if (await Bun.file(indexCandidate).exists()) return indexCandidate
          }
          return resolved
        })
      imports = (await Promise.all(importPromises)).filter(Boolean)

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

    return { filePath, imports, exports, functions, classes, complexity, lastModified, content: source }
  } catch (err) {
    log.warn(`[code-indexer] Failed to index ${filePath}: ${(err as Error).message}`)
    return null
  }
}

function codeFileId(sessionId: string, filePath: string): string {
  return `${sessionId}:${filePath}`
}

async function upsertFileGraphIndex(sessionId: string, index: FileIndex): Promise<void> {
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const id = codeFileId(sessionId, index.filePath)
  const existing = await codeGraph.get(id)
  await codeGraph.put(id, {
    id,
    session_id: sessionId,
    file_path: index.filePath,
    imports: JSON.stringify(index.imports),
    exported_by: existing?.doc.exported_by ?? "[]",
    exports: JSON.stringify(index.exports),
    functions: JSON.stringify(index.functions),
    classes: JSON.stringify(index.classes),
    complexity: index.complexity,
    last_modified: index.lastModified,
    indexed_at: new Date().toISOString(),
  }, { expectedVersion: existing?.version ?? 0 })
}

async function upsertFileSearchIndex(sessionId: string, index: FileIndex): Promise<void> {
  const codeFiles = await col<CodeFileDoc>("codeFiles")
  const id = codeFileId(sessionId, index.filePath)
  const importSymbols = index.imports.join(" ")
  const exportedSymbols = index.exports.join(" ")
  const functionSymbols = index.functions.join(" ")
  const classSymbols = index.classes.join(" ")

  await codeFiles.put(id, {
    id,
    session_id: sessionId,
    file_path: index.filePath,
    content: index.content,
    imports: importSymbols,
    exports: exportedSymbols,
    functions: functionSymbols,
    classes: classSymbols,
    updated_at: Math.floor(Date.now() / 1000),
  })

  await upsertCapabilityDocs([{
    type: "code",
    rawId: id,
    name: path.basename(index.filePath),
    body: index.content,
    tags: [index.filePath, importSymbols, exportedSymbols, functionSymbols, classSymbols].filter(Boolean).join(" "),
    extraFilters: [
      { field: "session_id", value: sessionId },
      { field: "code_file_id", value: id },
    ],
  }])
}

async function upsertFileIndex(sessionId: string, index: FileIndex): Promise<void> {
  await upsertFileGraphIndex(sessionId, index)
  await upsertFileSearchIndex(sessionId, index)
}

async function deleteFileSearchIndex(sessionId: string, filePath: string): Promise<void> {
  const codeFiles = await col<CodeFileDoc>("codeFiles")
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const id = codeFileId(sessionId, filePath)
  await codeFiles.delete(id)
  await codeGraph.delete(id)
  await deleteCapabilitiesByFilter("code_file_id", id)
}

async function buildExportedByIndex(sessionId: string): Promise<void> {
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const rows = await codeGraph.findBy("session_id", sessionId)

  // Build reverse map: for each file, who imports it?
  const importedBy = new Map<string, string[]>()
  for (const row of rows.map((entry) => entry.doc)) {
    const imports: string[] = JSON.parse(row.imports ?? "[]")
    for (const dep of imports) {
      if (!importedBy.has(dep)) importedBy.set(dep, [])
      importedBy.get(dep)!.push(row.file_path)
    }
  }

  // Update exported_by for all files in batch
  for (const entry of rows) {
    const importers = importedBy.get(entry.doc.file_path) ?? []
    await codeGraph.put(entry.id, { ...entry.doc, exported_by: JSON.stringify(importers) }, { expectedVersion: entry.version })
  }
}

/**
 * Full index: scan all code files in workspace and populate codeGraph.
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

  // Clear previous HiveDB search index for this session to avoid stale entries
  await deleteCapabilitiesByFilter("session_id", sessionId)
  const codeFiles = await col<CodeFileDoc>("codeFiles")
  const existingCodeFiles = await codeFiles.findBy("session_id", sessionId)
  for (const e of existingCodeFiles) await codeFiles.delete(e.id)
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const existingGraph = await codeGraph.findBy("session_id", sessionId)
  for (const e of existingGraph) await codeGraph.delete(e.id)

  // Index in batches of 50 to avoid blocking
  const BATCH = 50
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(f => indexFile(f, workspace)))
    for (const result of results) {
      if (result) {
        await upsertFileGraphIndex(sessionId, result)
        indexed++
      } else {
        skipped++
      }
    }
    await Promise.all(results.filter((r): r is FileIndex => !!r).map(r => upsertFileSearchIndex(sessionId, r)))
  }

  // Build reverse dependency map
  await buildExportedByIndex(sessionId)

  // Build global project context summary for Bee (async, non-blocking)
  await buildProjectContext(sessionId, workspace)

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

  await upsertFileIndex(sessionId, result)
  await buildExportedByIndex(sessionId)
  log.info(`[code-indexer] Updated index for ${path.relative(workspace, filePath)}`)
}

/**
 * Query: who imports this file? Returns file paths that depend on it.
 */
export async function getDependents(sessionId: string, filePath: string): Promise<string[]> {
  const row = await (await col<CodeGraphDoc>("codeGraph")).get(codeFileId(sessionId, filePath))
  if (!row) return []
  return JSON.parse(row.doc.exported_by ?? "[]")
}

/**
 * Query: what does this file import? Returns file paths it depends on.
 */
export async function getDependencies(sessionId: string, filePath: string): Promise<string[]> {
  const row = await (await col<CodeGraphDoc>("codeGraph")).get(codeFileId(sessionId, filePath))
  if (!row) return []
  return JSON.parse(row.doc.imports ?? "[]")
}

/**
 * Query: most imported files (highest centrality = most critical).
 */
export async function getMostCriticalFiles(sessionId: string, limit = 20): Promise<Array<{
  filePath: string
  importCount: number
  complexity: number
}>> {
  const rows = (await (await col<CodeGraphDoc>("codeGraph")).findBy("session_id", sessionId))
    .map((entry) => entry.doc)
    .sort((a, b) => b.exported_by.length - a.exported_by.length)
    .slice(0, 50)

  return rows
    .map((row) => ({
      filePath: row.file_path,
      importCount: (JSON.parse(row.exported_by ?? "[]") as string[]).length,
      complexity: row.complexity ?? 0,
    }))
    .sort((a, b) => b.importCount - a.importCount)
    .slice(0, limit)
}

/**
 * Get the most recently active code session ID.
 * Used by hooks that don't have explicit session context.
 */
export async function getActiveSessionId(): Promise<string | null> {
  const rows = (await (await col<CodeSessionDoc>("codeSessions")).findBy("status", "active"))
    .map((entry) => entry.doc)
    .sort((a, b) => b.last_active.localeCompare(a.last_active))
  return rows[0]?.id ?? null
}

/**
 * Reconcile: scan files whose mtime changed since last index and re-index them.
 * Call this on startup or periodically to catch external edits.
 */
export async function reconcileCodeIndex(sessionId: string, workspace: string): Promise<{
  reindexed: number
  removed: number
  durationMs: number
}> {
  const t0 = performance.now()

  // 1. Find files in DB that no longer exist on disk → remove from both tables
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const dbFiles = (await codeGraph.findBy("session_id", sessionId)).map((entry) => entry.doc)

  let removed = 0
  for (const { file_path } of dbFiles) {
    if (!await Bun.file(file_path).exists()) {
      await deleteFileSearchIndex(sessionId, file_path)
      removed++
    }
  }

  // 2. Find files whose mtime differs from last_modified in DB
  const staleRows = (await codeGraph.findBy("session_id", sessionId)).map((entry) => entry.doc)

  const toReindex: string[] = []
  for (const row of staleRows) {
    try {
      const stat = fs.statSync(row.file_path)
      const dbTime = new Date(row.last_modified).getTime()
      const fsTime = stat.mtime.getTime()
      if (Math.abs(dbTime - fsTime) > 1000) {
        toReindex.push(row.file_path)
      }
    } catch {
      // file missing — already handled above
    }
  }

  // 3. Also find new files not yet in DB
  const glob = new Bun.Glob(`**/*.{${CODE_EXTENSIONS.join(",")}}`)
  const dbPaths = new Set(dbFiles.map(r => r.file_path))
  for await (const relPath of glob.scan({ cwd: workspace, onlyFiles: true })) {
    const parts = relPath.split(path.sep)
    if (parts.some(p => SKIP_DIRS.has(p))) continue
    const absPath = path.resolve(workspace, relPath)
    if (!dbPaths.has(absPath)) {
      toReindex.push(absPath)
    }
  }

  // 4. Re-index stale/new files
  let reindexed = 0
  const BATCH = 50
  for (let i = 0; i < toReindex.length; i += BATCH) {
    const batch = toReindex.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(f => indexFile(f, workspace)))
    for (const result of results) {
      if (result) {
        await upsertFileGraphIndex(sessionId, result)
        reindexed++
      }
    }
    await Promise.all(results.filter((r): r is FileIndex => !!r).map(r => upsertFileSearchIndex(sessionId, r)))
  }

  // Rebuild reverse dependency map after reconciliation
  if (reindexed > 0 || removed > 0) {
    await buildExportedByIndex(sessionId)
  }

  // Rebuild project context if anything changed (async, non-blocking)
  if (reindexed > 0 || removed > 0) {
    const sessionRow = (await (await col<CodeSessionDoc>("codeSessions")).get(sessionId))?.doc
    if (sessionRow?.project_path) {
      await buildProjectContext(sessionId, sessionRow.project_path)
    }
  }

  const durationMs = Math.round(performance.now() - t0)
  log.info(`[code-indexer] Reconcile complete: ${reindexed} reindexed, ${removed} removed in ${durationMs}ms`)
  return { reindexed, removed, durationMs }
}
