/**
 * Questions about the code that the index answers without reading a file: what a file declares and
 * on which lines, where a symbol lives, who depends on a file.
 *
 * Each answer carries `indexed_at` and `stale`: a file edited since it was indexed (its mtime moved)
 * is flagged so the reader knows to confirm on disk before editing. Reading the ranges these point
 * to is `fs_read` with offset/limit.
 */
import fs from "node:fs"
import path from "node:path"
import type { Tool } from "../types.ts"
import { col, ensureIndexes } from "../../storage/hive.ts"
import type { CodeGraphDoc } from "../../storage/collections.ts"
import { resolveProjectScope, scopeFromConfig, type ProjectScope } from "../../agent/project-context.ts"
import type { SourceSymbol } from "../../agent/source-symbols.ts"

const MAX_SYMBOL_HITS = 30
const MAX_LIST = 25

const list = <T,>(raw: string | null | undefined): T[] => {
  try { const value = JSON.parse(raw || "[]"); return Array.isArray(value) ? value : [] } catch { return [] }
}

async function projectGraphs(scope: ProjectScope): Promise<CodeGraphDoc[]> {
  await ensureIndexes([["codeGraph", "session_id"]])
  return (await (await col<CodeGraphDoc>("codeGraph")).findBy("session_id", scope.sessionId)).map(entry => entry.doc)
}

const relativeTo = (scope: ProjectScope, file: string) => (path.isAbsolute(file) ? path.relative(scope.workspace, file) : file)

/** The graph row of a file given as relative or absolute path, or as a unique path suffix. */
function findGraph(graphs: CodeGraphDoc[], scope: ProjectScope, target: string): CodeGraphDoc | undefined {
  const wanted = path.normalize(target)
  const exact = graphs.find(g => g.file_path === path.resolve(scope.workspace, wanted) || path.normalize(relativeTo(scope, g.file_path)) === wanted)
  if (exact) return exact
  const tails = graphs.filter(g => g.file_path.endsWith(path.sep + wanted))
  return tails.length === 1 ? tails[0] : undefined
}

/** True when the file on disk changed after it was indexed (or is gone). */
function isStale(scope: ProjectScope, graph: CodeGraphDoc): boolean {
  try {
    const onDisk = fs.statSync(path.isAbsolute(graph.file_path) ? graph.file_path : path.join(scope.workspace, graph.file_path))
    return !!graph.last_modified && onDisk.mtime.toISOString() !== graph.last_modified
  } catch { return true }
}

async function scoped(params: Record<string, unknown>, config: any): Promise<ProjectScope | { ok: false; error: string }> {
  const scope = await resolveProjectScope(scopeFromConfig(params, config))
  return scope ?? { ok: false, error: "No project session found. Supply session_id and workspace." }
}

const row = (symbol: SourceSymbol) => ({
  name: symbol.name, kind: symbol.kind, lines: `${symbol.startLine}-${symbol.endLine}`,
  ...(symbol.exported ? { exported: true } : {}), ...(symbol.signature ? { signature: symbol.signature } : {}),
})

const SESSION_PARAMS = {
  session_id: { type: "string", description: "Explicit code session" },
  workspace: { type: "string", description: "Project workspace" },
} as const

export const outlineTool: Tool = {
  name: "outline",
  description: "List what a source file declares (functions, classes, methods, types) with the line range of each, plus what it imports and exports, from the project index. Cheaper than reading the file: use it to decide WHICH lines to read, then fs_read with offset/limit. Spanish: esquema del archivo, símbolos de un archivo, qué define este archivo",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "File path, relative to the workspace" }, ...SESSION_PARAMS },
    required: ["path"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    try {
      const scope = await scoped(params, config)
      if ("ok" in scope) return scope
      const target = String(params.path ?? "").trim()
      if (!target) return { ok: false, error: "path is required" }
      const graph = findGraph(await projectGraphs(scope), scope, target)
      if (!graph) return { ok: false, error: `${target} is not in the index (new, ignored or not a source file); use fs_read.` }
      return {
        ok: true, path: relativeTo(scope, graph.file_path), indexed_at: graph.indexed_at, stale: isStale(scope, graph),
        symbols: list<SourceSymbol>(graph.symbols_json).map(row),
        imports: list<string>(graph.imports).slice(0, MAX_LIST).map(p => relativeTo(scope, p)),
        exports: list<string>(graph.exports).slice(0, MAX_LIST),
      }
    } catch (error) { return { ok: false, error: `outline failed: ${(error as Error).message}` } }
  },
}

export const findSymbolTool: Tool = {
  name: "find_symbol",
  description: "Find where a function, class, method, type or constant is defined, by name (exact first, then partial), with file and line range, from the project index. Use it instead of grepping the repo for a definition. Spanish: dónde está definido, buscar símbolo, definición de función o clase",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Symbol name, e.g. 'buildContextPacket' or 'Store.load'" },
      kind: { type: "string", description: "Only this kind: function, class, method, interface, type, const, enum…" },
      ...SESSION_PARAMS,
    },
    required: ["name"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    try {
      const scope = await scoped(params, config)
      if ("ok" in scope) return scope
      const name = String(params.name ?? "").trim()
      if (!name) return { ok: false, error: "name is required" }
      const kind = typeof params.kind === "string" && params.kind ? params.kind : undefined
      const lower = name.toLowerCase()
      const hits: Array<{ rank: number; file: CodeGraphDoc; symbol: SourceSymbol }> = []
      for (const file of await projectGraphs(scope)) {
        for (const symbol of list<SourceSymbol>(file.symbols_json)) {
          if (kind && symbol.kind !== kind) continue
          const full = symbol.name.toLowerCase()
          const leaf = full.split(".").pop() ?? full
          const rank = full === lower ? 0 : leaf === lower ? 1 : full.includes(lower) ? 2 : -1
          if (rank >= 0) hits.push({ rank, file, symbol })
        }
      }
      hits.sort((a, b) => a.rank - b.rank || Number(!!b.symbol.exported) - Number(!!a.symbol.exported) || a.file.file_path.localeCompare(b.file.file_path))
      const shown = hits.slice(0, MAX_SYMBOL_HITS)
      return {
        ok: true, name, total: hits.length,
        matches: shown.map(({ file, symbol }) => ({ path: relativeTo(scope, file.file_path), ...row(symbol), stale: isStale(scope, file) })),
        ...(hits.length > shown.length ? { note: `Showing ${shown.length} of ${hits.length}; give a fuller name or a kind.` } : {}),
        ...(hits.length === 0 ? { note: "No symbol by that name in the index; search_knowledge(type=\"code\") finds text, search_in_files exact strings." } : {}),
      }
    } catch (error) { return { ok: false, error: `find_symbol failed: ${(error as Error).message}` } }
  },
}

export const dependentsTool: Tool = {
  name: "dependents",
  description: "Which files import a given file, and which files it imports, from the project index. Use it to see what a change can break before reading the callers. File level, not per call site. Spanish: quién usa este archivo, dependientes, qué importa, impacto de un cambio",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "File path, relative to the workspace" }, ...SESSION_PARAMS },
    required: ["path"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    try {
      const scope = await scoped(params, config)
      if ("ok" in scope) return scope
      const target = String(params.path ?? "").trim()
      if (!target) return { ok: false, error: "path is required" }
      const graph = findGraph(await projectGraphs(scope), scope, target)
      if (!graph) return { ok: false, error: `${target} is not in the index; use search_in_files for its name.` }
      const importedBy = list<string>(graph.exported_by).map(p => relativeTo(scope, p))
      const imports = list<string>(graph.imports).map(p => relativeTo(scope, p))
      return {
        ok: true, path: relativeTo(scope, graph.file_path), indexed_at: graph.indexed_at, stale: isStale(scope, graph),
        imported_by: importedBy.slice(0, MAX_LIST), imported_by_total: importedBy.length,
        imports: imports.slice(0, MAX_LIST), imports_total: imports.length,
        ...(graph.relations_complete === false ? { note: "Imports of this file type are not fully indexed." } : {}),
      }
    } catch (error) { return { ok: false, error: `dependents failed: ${(error as Error).message}` } }
  },
}

export const codeIndexTools: Tool[] = [outlineTool, findSymbolTool, dependentsTool]
