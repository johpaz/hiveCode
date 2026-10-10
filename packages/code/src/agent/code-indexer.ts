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
  deleteCapabilitiesByFilter,
} from "@johpaz/hivecode-core/agent/capability-search"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import * as path from "node:path"
import * as fs from "node:fs"
import { buildProjectContext } from "./context-retriever"

const log = logger.child("code-indexer")

import { CODE_EXTENSIONS, SKIP_DIRS, indexFile, upsertFileGraphIndex, upsertFileSearchIndex, upsertFileIndex,
  deleteFileSearchIndex, buildExportedByIndex, codeFileId, shouldIndexFile, type FileIndex } from "@johpaz/hivecode-core/agent/source-index"
export { shouldIndexFile } from "@johpaz/hivecode-core/agent/source-index"

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
    if (parts.some(p => SKIP_DIRS.has(p)) || !shouldIndexFile(path.resolve(workspace, relPath), workspace)) continue
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

/** Debounce window for the session-wide rebuild that follows file edits. */
const REBUILD_DEBOUNCE_MS = 750

interface PendingRebuild { timer: ReturnType<typeof setTimeout>; workspace: string }
const pendingRebuilds = new Map<string, PendingRebuild>()

async function runSessionRebuild(sessionId: string, workspace: string): Promise<void> {
  await buildExportedByIndex(sessionId)
  await buildProjectContext(sessionId, workspace)
}

/**
 * Run any scheduled session-wide rebuild now. Readers of derived data
 * (exported_by, project context) call this so they never see a stale graph.
 */
export async function flushIndexRebuild(sessionId: string): Promise<void> {
  const pending = pendingRebuilds.get(sessionId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingRebuilds.delete(sessionId)
  await runSessionRebuild(sessionId, pending.workspace)
}

function scheduleSessionRebuild(sessionId: string, workspace: string): void {
  const existing = pendingRebuilds.get(sessionId)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    pendingRebuilds.delete(sessionId)
    runSessionRebuild(sessionId, workspace).catch((err) => {
      log.warn(`[code-indexer] Deferred rebuild failed: ${(err as Error).message}`)
    })
  }, REBUILD_DEBOUNCE_MS)
  // Do not keep the process alive just to refresh a cache.
  ;(timer as { unref?: () => void }).unref?.()
  pendingRebuilds.set(sessionId, { timer, workspace })
}

/**
 * Incremental update: re-index a single file after it's been edited.
 * The file's own rows are written immediately; the session-wide derived data
 * (exported_by, project context) is coalesced so a burst of N edits costs one
 * session scan instead of N.
 */
export async function updateFileIndex(sessionId: string, filePath: string, workspace: string): Promise<void> {
  const result = await indexFile(filePath, workspace)
  if (!result) {
    await deleteFileSearchIndex(sessionId, filePath)
    scheduleSessionRebuild(sessionId, workspace)
    return
  }

  await upsertFileIndex(sessionId, result)
  scheduleSessionRebuild(sessionId, workspace)
  log.info(`[code-indexer] Updated index for ${path.relative(workspace, filePath)}`)
}

/**
 * Query: who imports this file? Returns file paths that depend on it.
 */
export async function getDependents(sessionId: string, filePath: string): Promise<string[]> {
  await flushIndexRebuild(sessionId)
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
  await flushIndexRebuild(sessionId)
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
    if (!shouldIndexFile(file_path, workspace) || !await Bun.file(file_path).exists()) {
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
      // lastModified is stored as the file's mtime, so a match means unchanged.
      // Hashing every file here read the whole repo on each reconcile.
      if (dbTime !== fsTime) {
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
    if (parts.some(p => SKIP_DIRS.has(p)) || !shouldIndexFile(path.resolve(workspace, relPath), workspace)) continue
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
