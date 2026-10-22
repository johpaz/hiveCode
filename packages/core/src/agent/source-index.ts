/** Shared source indexing for CLI startup and live agent filesystem mutations. */
import path from "node:path"
import fs from "node:fs"
import { createHash } from "node:crypto"
import { col, ensureIndexes } from "../storage/hive"
import { getHiveDb } from "../storage/hivedb"
import type { CodeFileDoc, CodeGraphDoc } from "../storage/collections"
import { upsertCapabilityDocs, deleteCapabilitiesByFilter } from "./capability-search"
import { logger } from "../utils/logger"
import { extractSymbols, type SourceSymbol } from "./source-symbols"
import { resolveWorkspaceImport } from "./workspace-packages"
const log = logger.child("source-index")
export const CODE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs", "rs", "sql", "json", "toml", "md"]
const JS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"])

export function shouldIndexFile(filePath: string, workspace: string): boolean {
  const relative = path.relative(workspace, filePath)
  return !relative.startsWith("..") && !path.isAbsolute(relative) &&
    !relative.split(path.sep).some(part => SKIP_DIRS.has(part) || part.startsWith(".env") || part === "secrets") &&
    !/^(?:credentials|secrets)\.(?:json|toml)$/i.test(path.basename(filePath)) &&
    CODE_EXTENSIONS.includes(path.extname(filePath).slice(1)) &&
    !/(?:lock|lockfile)\.(?:json|toml)$/.test(filePath)
}
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "target", ".aws", ".ssh", "secrets"])

export interface FileIndex {
  filePath: string
  imports: string[]
  exports: string[]
  functions: string[]
  classes: string[]
  complexity: number
  lastModified: string
  content: string
  contentHash: string
  symbols: SourceSymbol[]
  relationsComplete: boolean
}

export async function indexFile(filePath: string, workspace: string): Promise<FileIndex | null> {
  try {
    if (!shouldIndexFile(filePath, workspace)) return null
    const realRoot = fs.realpathSync(workspace)
    const real = fs.realpathSync(filePath)
    if (path.relative(realRoot, real).startsWith("..")) return null
    const file = Bun.file(filePath)
    if (!(await file.exists())) return null

    if (file.size > 1_000_000) return null
    const source = await file.text()
    if (source.includes("\0")) return null
    const stat = fs.statSync(filePath)
    const lastModified = stat.mtime.toISOString()

    const ext = filePath.split(".").pop() ?? "ts"
    const loader = (ext === "tsx" || ext === "jsx") ? "tsx" : "ts"

    const transpiler = JS_EXTENSIONS.has(ext) ? new Bun.Transpiler({ loader: loader as any }) : null

    // Extract imports and exports via scanner
    let imports: string[] = []
    let exports: string[] = []
    try {
      const scan = transpiler?.scan(source) ?? { imports: [], exports: [] }
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
      // Imports through a workspace package name resolve to the source file that package exports.
      for (const spec of (scan.imports ?? []).map((i: any) => i.path as string).filter((p: string) => !p.startsWith("."))) {
        const resolved = resolveWorkspaceImport(workspace, spec)
        if (resolved && resolved !== filePath && !imports.includes(resolved)) imports.push(resolved)
      }

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

    const symbols = extractSymbols(source, ext)
    if (ext === "rs") {
      functions.push(...symbols.filter(s => s.kind === "fn").map(s => s.name))
      classes.push(...symbols.filter(s => ["struct", "enum", "trait"].includes(s.kind)).map(s => s.name))
    }
    // Everything stored is relative to the project root: the same file is the same row from the project or any worktree.
    const toRelative = (abs: string) => path.relative(workspace, abs)
    const relativeImports = [...new Set(imports.map(toRelative).filter(rel => rel && !rel.startsWith("..") && !path.isAbsolute(rel)))]
    return { filePath: toRelative(filePath), imports: relativeImports, exports, functions, classes, complexity, lastModified, content: source,
      contentHash: createHash("sha256").update(source).digest("hex"), symbols, relationsComplete: JS_EXTENSIONS.has(ext) }

  } catch (err) {
    log.warn(`[code-indexer] Failed to index ${filePath}: ${(err as Error).message}`)
    return null
  }
}

export function codeFileId(projectId: string, relPath: string): string {
  return `${projectId}:${relPath}`
}

/** Documents per commit. One commit per file is what made indexing 665 files take 26 s; batched it takes under one. */
const WRITE_BATCH = 100

type GraphRow = CodeGraphDoc

function graphRow(projectId: string, index: FileIndex, exportedBy: string): GraphRow {
  return {
    id: codeFileId(projectId, index.filePath),
    project_id: projectId,
    file_path: index.filePath,
    imports: JSON.stringify(index.imports),
    exported_by: exportedBy,
    exports: JSON.stringify(index.exports),
    functions: JSON.stringify(index.functions),
    classes: JSON.stringify(index.classes),
    complexity: index.complexity,
    last_modified: index.lastModified,
    indexed_at: new Date().toISOString(),
    content_hash: index.contentHash,
    symbols_json: JSON.stringify(index.symbols),
    relations_complete: index.relationsComplete,
  }
}

/** Puts documents in one atomic commit per chunk. */
async function putMany(collection: string, entries: Array<{ id: string; doc: unknown }>): Promise<void> {
  const db = await getHiveDb()
  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    await db.batch(entries.slice(i, i + WRITE_BATCH).map(({ id, doc }) => ({ op: "put" as const, collection, id, doc })))
  }
}

/** Graph rows for several files at once; a file already indexed keeps its `exported_by`. */
export async function upsertFileGraphIndexBatch(projectId: string, indexes: FileIndex[]): Promise<void> {
  if (!indexes.length) return
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const existing = await Promise.all(indexes.map(index => codeGraph.get(codeFileId(projectId, index.filePath))))
  await putMany("codeGraph", indexes.map((index, i) => ({ id: codeFileId(projectId, index.filePath), doc: graphRow(projectId, index, existing[i]?.doc.exported_by ?? "[]") })))
}

export async function upsertFileGraphIndex(projectId: string, index: FileIndex): Promise<void> {
  await upsertFileGraphIndexBatch(projectId, [index])
}

/**
 * Search side of the index: a row per file in `codeFiles` and one document for `search_knowledge`.
 * The document's text is the file's name, path and symbols, not its contents: agents read the code from
 * disk, and storing it here only made the index three times the size of the project.
 */
export async function upsertFileSearchIndexBatch(projectId: string, indexes: FileIndex[]): Promise<void> {
  if (!indexes.length) return
  await putMany("codeFiles", indexes.map(index => ({
    id: codeFileId(projectId, index.filePath),
    doc: {
      id: codeFileId(projectId, index.filePath), project_id: projectId, file_path: index.filePath, content_hash: index.contentHash,
      symbols_json: JSON.stringify(index.symbols), imports: index.imports.join(" "), exports: index.exports.join(" "),
      functions: index.functions.join(" "), classes: index.classes.join(" "), updated_at: Math.floor(Date.now() / 1000),
    } satisfies CodeFileDoc,
  })))
  for (let i = 0; i < indexes.length; i += WRITE_BATCH) {
    await upsertCapabilityDocs(indexes.slice(i, i + WRITE_BATCH).map(index => {
      const id = codeFileId(projectId, index.filePath)
      const symbols = [...index.exports, ...index.functions, ...index.classes]
      return {
        type: "code" as const,
        rawId: id,
        name: path.basename(index.filePath),
        body: [index.filePath, ...symbols].join(" "),
        tags: [index.filePath, index.imports.join(" "), symbols.join(" ")].filter(Boolean).join(" "),
        extraFilters: [
          { field: "project_id", value: projectId },
          { field: "code_file_id", value: id },
        ],
      }
    }))
  }
}

export async function upsertFileSearchIndex(projectId: string, index: FileIndex): Promise<void> {
  await upsertFileSearchIndexBatch(projectId, [index])
}

export async function upsertFileIndex(projectId: string, index: FileIndex): Promise<void> {
  await upsertFileGraphIndex(projectId, index)
  await upsertFileSearchIndex(projectId, index)
}

export async function deleteFileSearchIndex(projectId: string, relPath: string): Promise<void> {
  const codeFiles = await col<CodeFileDoc>("codeFiles")
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const id = codeFileId(projectId, relPath)
  await codeFiles.delete(id)
  await codeGraph.delete(id)
  await deleteCapabilitiesByFilter("code_file_id", id)
}

/** Drops everything indexed for a project (before a full rebuild). */
export async function clearProjectIndex(projectId: string): Promise<void> {
  await deleteCapabilitiesByFilter("project_id", projectId)
  for (const name of ["codeFiles", "codeGraph"] as const) {
    const collection = await col<{ id: string }>(name)
    const db = await getHiveDb()
    const rows = await collection.findBy("project_id", projectId)
    for (let i = 0; i < rows.length; i += WRITE_BATCH) {
      await db.batch(rows.slice(i, i + WRITE_BATCH).map(row => ({ op: "delete" as const, collection: name, id: row.id })))
    }
  }
}

/**
 * Rebuilds who-imports-whom for the project. Only rows whose list actually changed are written: after an
 * edit that is a handful of files, and on a project that was just indexed it is all of them in a few commits.
 */
export async function buildExportedByIndex(projectId: string): Promise<void> {
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const rows = await codeGraph.findBy("project_id", projectId)

  const importedBy = new Map<string, string[]>()
  for (const { doc } of rows) {
    for (const dep of parseList(doc.imports)) {
      if (!importedBy.has(dep)) importedBy.set(dep, [])
      importedBy.get(dep)!.push(doc.file_path)
    }
  }

  const changed: Array<{ id: string; doc: unknown }> = []
  for (const entry of rows) {
    const next = JSON.stringify([...(importedBy.get(entry.doc.file_path) ?? [])].sort())
    if (next !== entry.doc.exported_by) changed.push({ id: entry.id, doc: { ...entry.doc, exported_by: next } })
  }
  await putMany("codeGraph", changed)
}


/**
 * Projects whose workspace was mutated by a tool that does not name its target (shell, scripts, git) or by a
 * worktree that was merged back. The index cannot be patched file-by-file for those, so the next context
 * read reconciles by mtime instead.
 */
const staleProjects = new Set<string>()

export async function markSourceIndexStale(projectId: string): Promise<void> {
  staleProjects.add(projectId)
  await (await col("codeContextCache")).delete(`project_context:${projectId}`)
}

/** True once per mark: the caller that sees it owns the reconcile. */
export function consumeStaleSourceIndex(projectId: string): boolean {
  return staleProjects.delete(projectId)
}

/**
 * Brings one edited file up to date. `root` is the project root; `workspace` is where the edit happened. An edit
 * inside a worktree is NOT written here: the worktree is a private copy, and its files reach the project only when
 * it is merged back, which marks the index stale. Returns whether the index was touched.
 */
export async function refreshSourceIndex(projectId: string, root: string, workspace: string, filePath: string): Promise<boolean> {
  if (fs.realpathSync(workspace) !== fs.realpathSync(root)) return false
  await ensureIndexes([["codeGraph", "project_id"], ["codeFiles", "project_id"]])
  const absolute = path.resolve(workspace, filePath)
  if (!shouldIndexFile(absolute, root)) return false
  const rel = path.relative(root, absolute)
  const before = await (await col<CodeGraphDoc>("codeGraph")).get(codeFileId(projectId, rel))
  const source = await indexFile(absolute, root)
  if (source) await upsertFileIndex(projectId, source)
  else await deleteFileSearchIndex(projectId, rel)
  // A new file may already be imported by others (their import did not resolve until now): that needs the whole map.
  // Any other edit only moves the edges of the file itself, which is a handful of rows, not one write per file.
  if (!before && source) await buildExportedByIndex(projectId)
  else await patchExportedBy(projectId, rel, parseList(before?.doc.imports), source?.imports ?? [])
  await (await col("codeContextCache")).delete(`project_context:${projectId}`)
  return true
}

const parseList = (raw: string | null | undefined): string[] => {
  try { const value = JSON.parse(raw || "[]"); return Array.isArray(value) ? value : [] } catch { return [] }
}

/**
 * Moves one file's edges in the reverse import map: `exported_by` of every file it stopped importing loses it,
 * of every file it started importing gains it. An edit that leaves the imports as they were writes nothing.
 */
export async function patchExportedBy(projectId: string, file: string, oldImports: string[], newImports: string[]): Promise<void> {
  const before = new Set(oldImports)
  const after = new Set(newImports)
  const touched = [
    ...[...before].filter(dep => !after.has(dep)).map(dep => ({ dep, add: false })),
    ...[...after].filter(dep => !before.has(dep)).map(dep => ({ dep, add: true })),
  ]
  if (!touched.length) return
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  for (const { dep, add } of touched) {
    const entry = await codeGraph.get(codeFileId(projectId, dep))
    if (!entry) continue // not indexed (a dependency, a generated file): nothing to keep
    const importers = new Set(parseList(entry.doc.exported_by))
    if (add) importers.add(file); else importers.delete(file)
    await codeGraph.put(entry.doc.id, { ...entry.doc, exported_by: JSON.stringify([...importers].sort()) }, { expectedVersion: entry.version })
  }
}
