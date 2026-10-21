/** Shared source indexing for CLI startup and live agent filesystem mutations. */
import path from "node:path"
import fs from "node:fs"
import { createHash } from "node:crypto"
import { col, ensureIndexes } from "../storage/hive"
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
    return { filePath, imports, exports, functions, classes, complexity, lastModified, content: source,
      contentHash: createHash("sha256").update(source).digest("hex"), symbols, relationsComplete: JS_EXTENSIONS.has(ext) }

  } catch (err) {
    log.warn(`[code-indexer] Failed to index ${filePath}: ${(err as Error).message}`)
    return null
  }
}

export function codeFileId(sessionId: string, filePath: string): string {
  return `${sessionId}:${filePath}`
}

export async function upsertFileGraphIndex(sessionId: string, index: FileIndex): Promise<void> {
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
    content_hash: index.contentHash,
    symbols_json: JSON.stringify(index.symbols),
    relations_complete: index.relationsComplete,
  }, { expectedVersion: existing?.version ?? 0 })
}

export async function upsertFileSearchIndex(sessionId: string, index: FileIndex): Promise<void> {
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
    content_hash: index.contentHash,
    symbols_json: JSON.stringify(index.symbols),
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

export async function upsertFileIndex(sessionId: string, index: FileIndex): Promise<void> {
  await upsertFileGraphIndex(sessionId, index)
  await upsertFileSearchIndex(sessionId, index)
}

export async function deleteFileSearchIndex(sessionId: string, filePath: string): Promise<void> {
  const codeFiles = await col<CodeFileDoc>("codeFiles")
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  const id = codeFileId(sessionId, filePath)
  await codeFiles.delete(id)
  await codeGraph.delete(id)
  await deleteCapabilitiesByFilter("code_file_id", id)
}

export async function buildExportedByIndex(sessionId: string): Promise<void> {
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
 * Sessions whose workspace was mutated by a tool that does not name its target
 * (shell, scripts, git). The index cannot be patched file-by-file for those, so
 * the next context read reconciles by mtime instead.
 */
const staleSessions = new Set<string>()

export async function markSourceIndexStale(sessionId: string): Promise<void> {
  staleSessions.add(sessionId)
  await (await col("codeContextCache")).delete(`project_context:${sessionId}`)
}

/** True once per mark: the caller that sees it owns the reconcile. */
export function consumeStaleSourceIndex(sessionId: string): boolean {
  return staleSessions.delete(sessionId)
}

export async function refreshSourceIndex(sessionId: string, workspace: string, filePath: string): Promise<void> {
  await ensureIndexes([["codeGraph", "session_id"], ["codeFiles", "session_id"]])
  const absolute = path.resolve(workspace, filePath)
  if (!shouldIndexFile(absolute, workspace)) return
  const before = await (await col<CodeGraphDoc>("codeGraph")).get(codeFileId(sessionId, absolute))
  const source = await indexFile(absolute, workspace)
  if (source) await upsertFileIndex(sessionId, source)
  else await deleteFileSearchIndex(sessionId, absolute)
  // A new file may already be imported by others (their import did not resolve until now): that needs the whole map.
  // Any other edit only moves the edges of the file itself, which is a handful of rows, not one write per file.
  if (!before && source) await buildExportedByIndex(sessionId)
  else await patchExportedBy(sessionId, absolute, parseList(before?.doc.imports), source?.imports ?? [])
  await (await col("codeContextCache")).delete(`project_context:${sessionId}`)
}

const parseList = (raw: string | null | undefined): string[] => {
  try { const value = JSON.parse(raw || "[]"); return Array.isArray(value) ? value : [] } catch { return [] }
}

/**
 * Moves one file's edges in the reverse import map: `exported_by` of every file it stopped importing loses it,
 * of every file it started importing gains it. An edit that leaves the imports as they were writes nothing.
 */
export async function patchExportedBy(sessionId: string, file: string, oldImports: string[], newImports: string[]): Promise<void> {
  const before = new Set(oldImports)
  const after = new Set(newImports)
  const touched = [
    ...[...before].filter(dep => !after.has(dep)).map(dep => ({ dep, add: false })),
    ...[...after].filter(dep => !before.has(dep)).map(dep => ({ dep, add: true })),
  ]
  if (!touched.length) return
  const codeGraph = await col<CodeGraphDoc>("codeGraph")
  for (const { dep, add } of touched) {
    const entry = await codeGraph.get(codeFileId(sessionId, dep))
    if (!entry) continue // not indexed (a dependency, a generated file): nothing to keep
    const importers = new Set(parseList(entry.doc.exported_by))
    if (add) importers.add(file); else importers.delete(file)
    await codeGraph.put(entry.doc.id, { ...entry.doc, exported_by: JSON.stringify([...importers]) }, { expectedVersion: entry.version })
  }
}
