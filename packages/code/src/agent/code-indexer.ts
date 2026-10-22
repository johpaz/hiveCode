/**
 * Code Indexer — builds and maintains the HiveDB code graph of a PROJECT.
 *
 * The index belongs to the project (see `agent/project-identity.ts`), not to a session: opening the same
 * project again, from a new session or a worktree, finds it already there and only reconciles what changed.
 * Paths in the index are relative to the project root.
 *
 * - Full index: scans all code files via Bun.Glob, in batches
 * - Incremental: after each fs_edit / fs_write only the affected file is re-indexed
 *
 * Uses Bun.Transpiler for lightweight AST analysis (no tsc needed).
 */

import { createHash } from "node:crypto"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeGraphDoc, CodeProjectDoc, CodeSessionDoc } from "@johpaz/hivecode-core/storage/collections"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import * as path from "node:path"
import * as fs from "node:fs"
import { buildProjectContext } from "./context-retriever"

const log = logger.child("code-indexer")

import { CODE_EXTENSIONS, SKIP_DIRS, indexFile, upsertFileGraphIndexBatch, upsertFileSearchIndexBatch, upsertFileIndex,
  deleteFileSearchIndex, buildExportedByIndex, clearProjectIndex, codeFileId, shouldIndexFile, type FileIndex } from "@johpaz/hivecode-core/agent/source-index"

export { shouldIndexFile } from "@johpaz/hivecode-core/agent/source-index"

/** Files per parse batch. */
const PARSE_BATCH = 50

/** Every indexable file under `root`, as absolute paths. */
async function scanProjectFiles(root: string): Promise<string[]> {
  const glob = new Bun.Glob(`**/*.{${CODE_EXTENSIONS.join(",")}}`)
  const files: string[] = []
  for await (const relPath of glob.scan({ cwd: root, onlyFiles: true })) {
    if (relPath.split(path.sep).some(part => SKIP_DIRS.has(part)) || !shouldIndexFile(path.resolve(root, relPath), root)) continue
    files.push(path.resolve(root, relPath))
  }
  return files
}

/** Parses the files and writes them in batches; returns how many were indexed and how many were skipped. */
async function indexFiles(projectId: string, root: string, files: string[]): Promise<{ indexed: number; skipped: number }> {
  let indexed = 0
  let skipped = 0
  for (let i = 0; i < files.length; i += PARSE_BATCH) {
    const results = await Promise.all(files.slice(i, i + PARSE_BATCH).map(file => indexFile(file, root)))
    const ok = results.filter((result): result is FileIndex => !!result)
    skipped += results.length - ok.length
    await upsertFileGraphIndexBatch(projectId, ok)
    await upsertFileSearchIndexBatch(projectId, ok)
    indexed += ok.length
  }
  return { indexed, skipped }
}

async function markIndexed(projectId: string): Promise<void> {
  const projects = await col<CodeProjectDoc>("codeProjects")
  const row = await projects.get(projectId)
  if (row) await projects.put(projectId, { ...row.doc, indexed_at: new Date().toISOString(), updated_at: Date.now() }, { expectedVersion: row.version }).catch(() => {})
}

/**
 * Full index: scan all code files in the project and populate codeGraph.
 * Called at `hive-code init`.
 */
export async function buildFullIndex(projectId: string, root: string): Promise<{
  indexed: number
  skipped: number
  durationMs: number
}> {
  const t0 = performance.now()
  log.info(`[code-indexer] Building full index for project ${projectId} in ${root}`)
  const files = await scanProjectFiles(root)
  log.info(`[code-indexer] Found ${files.length} files to index`)

  // Clear the previous index of this project so removed files do not linger.
  await clearProjectIndex(projectId)
  const { indexed, skipped } = await indexFiles(projectId, root, files)

  await buildExportedByIndex(projectId)
  await buildProjectContext(projectId, root)
  await markIndexed(projectId)

  const durationMs = Math.round(performance.now() - t0)
  log.info(`[code-indexer] Full index complete: ${indexed} indexed, ${skipped} skipped in ${durationMs}ms`)
  return { indexed, skipped, durationMs }
}

/** Debounce window for the project-wide rebuild that follows file edits. */
const REBUILD_DEBOUNCE_MS = 750

interface PendingRebuild { timer: ReturnType<typeof setTimeout>; root: string }
const pendingRebuilds = new Map<string, PendingRebuild>()

async function runProjectRebuild(projectId: string, root: string): Promise<void> {
  await buildExportedByIndex(projectId)
  await buildProjectContext(projectId, root)
}

/**
 * Run any scheduled project-wide rebuild now. Readers of derived data
 * (exported_by, project context) call this so they never see a stale graph.
 */
export async function flushIndexRebuild(projectId: string): Promise<void> {
  const pending = pendingRebuilds.get(projectId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingRebuilds.delete(projectId)
  await runProjectRebuild(projectId, pending.root)
}

function scheduleProjectRebuild(projectId: string, root: string): void {
  const existing = pendingRebuilds.get(projectId)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    pendingRebuilds.delete(projectId)
    runProjectRebuild(projectId, root).catch((err) => {
      log.warn(`[code-indexer] Deferred rebuild failed: ${(err as Error).message}`)
    })
  }, REBUILD_DEBOUNCE_MS)
  // Do not keep the process alive just to refresh a cache.
  ;(timer as { unref?: () => void }).unref?.()
  pendingRebuilds.set(projectId, { timer, root })
}

/**
 * Incremental update: re-index a single file after it's been edited.
 * The file's own rows are written immediately; the project-wide derived data
 * (exported_by, project context) is coalesced so a burst of N edits costs one
 * scan instead of N. `filePath` may be absolute or relative to `root`.
 */
export async function updateFileIndex(projectId: string, filePath: string, root: string): Promise<void> {
  const absolute = path.resolve(root, filePath)
  const result = await indexFile(absolute, root)
  if (!result) {
    await deleteFileSearchIndex(projectId, path.relative(root, absolute))
    scheduleProjectRebuild(projectId, root)
    return
  }

  await upsertFileIndex(projectId, result)
  scheduleProjectRebuild(projectId, root)
  log.info(`[code-indexer] Updated index for ${result.filePath}`)
}

/**
 * Query: who imports this file? Returns file paths that depend on it.
 */
export async function getDependents(projectId: string, relPath: string): Promise<string[]> {
  await flushIndexRebuild(projectId)
  const row = await (await col<CodeGraphDoc>("codeGraph")).get(codeFileId(projectId, relPath))
  if (!row) return []
  return JSON.parse(row.doc.exported_by ?? "[]")
}

/**
 * Query: what does this file import? Returns file paths it depends on.
 */
export async function getDependencies(projectId: string, relPath: string): Promise<string[]> {
  const row = await (await col<CodeGraphDoc>("codeGraph")).get(codeFileId(projectId, relPath))
  if (!row) return []
  return JSON.parse(row.doc.imports ?? "[]")
}

/**
 * Query: most imported files (highest centrality = most critical).
 */
export async function getMostCriticalFiles(projectId: string, limit = 20): Promise<Array<{
  filePath: string
  importCount: number
  complexity: number
}>> {
  await flushIndexRebuild(projectId)
  const rows = (await (await col<CodeGraphDoc>("codeGraph")).findBy("project_id", projectId))
    .map((entry) => entry.doc)
    .map((row) => ({
      filePath: row.file_path,
      importCount: (JSON.parse(row.exported_by ?? "[]") as string[]).length,
      complexity: row.complexity ?? 0,
    }))
  return rows.sort((a, b) => b.importCount - a.importCount).slice(0, limit)
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

export interface ReconcileResult { reindexed: number; removed: number; durationMs: number }

/** One reconcile per project at a time: a second caller (another session, a stale mark) waits for the running one. */
const reconciling = new Map<string, Promise<ReconcileResult>>()

/**
 * Reconcile: bring the project's index in line with the disk. Files whose mtime moved are re-hashed and
 * re-indexed only if their content changed; new files are added; deleted ones are dropped. On a project that
 * is already indexed and untouched this reads the tree and writes nothing.
 */
export function reconcileCodeIndex(projectId: string, root: string): Promise<ReconcileResult> {
  const running = reconciling.get(projectId)
  if (running) return running
  const job = reconcileOnce(projectId, root).finally(() => { reconciling.delete(projectId) })
  reconciling.set(projectId, job)
  return job
}

async function reconcileOnce(projectId: string, root: string): Promise<ReconcileResult> {
  const t0 = performance.now()
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const dbFiles = (await codeGraph.findBy("project_id", projectId)).map((entry) => entry.doc)
  const onDisk = (rel: string) => path.join(root, rel)

  // 1. Files in the index that no longer exist (or no longer qualify) → remove.
  let removed = 0
  const survivors: CodeGraphDoc[] = []
  for (const row of dbFiles) {
    if (!shouldIndexFile(onDisk(row.file_path), root) || !await Bun.file(onDisk(row.file_path)).exists()) {
      await deleteFileSearchIndex(projectId, row.file_path)
      removed++
    } else survivors.push(row)
  }

  // 2. Files whose mtime moved. Only those are hashed: a touch or a checkout that left the content alone just
  //    records the new mtime instead of re-parsing the file.
  const toReindex: string[] = []
  for (const row of survivors) {
    try {
      const stat = fs.statSync(onDisk(row.file_path))
      if (new Date(row.last_modified ?? 0).getTime() === stat.mtime.getTime()) continue
      const hash = row.content_hash ? createHash("sha256").update(await Bun.file(onDisk(row.file_path)).text()).digest("hex") : undefined
      if (hash && hash === row.content_hash) await codeGraph.put(row.id, { ...row, last_modified: stat.mtime.toISOString() })
      else toReindex.push(onDisk(row.file_path))
    } catch { /* gone between the two checks: the next reconcile drops it */ }
  }

  // 3. New files not yet in the index.
  const known = new Set(survivors.map(row => row.file_path))
  for (const absolute of await scanProjectFiles(root)) {
    if (!known.has(path.relative(root, absolute))) toReindex.push(absolute)
  }

  // 4. Re-index the changed and the new, in batches.
  const { indexed: reindexed } = await indexFiles(projectId, root, toReindex)

  if (reindexed > 0 || removed > 0) {
    await buildExportedByIndex(projectId)
    await buildProjectContext(projectId, root)
  }
  await markIndexed(projectId)

  const durationMs = Math.round(performance.now() - t0)
  log.info(`[code-indexer] Reconcile complete: ${reindexed} reindexed, ${removed} removed in ${durationMs}ms`)
  return { reindexed, removed, durationMs }
}
