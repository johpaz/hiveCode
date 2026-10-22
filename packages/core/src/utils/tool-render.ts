/**
 * What a tool's answer looks like to the model: plain text where the answer IS text.
 *
 * JSON and TOON both carry source code as one quoted string, so every quote becomes `\"` and every line break `\n`,
 * and a search repeats a file's absolute path on each of its matches. TOON dropped the keys, which is not where those
 * results spent their characters: on real answers it saved 0-15 % (the encoder has since been removed). Rendered as a `cat` or a `grep` would print them
 * (real line breaks, the path once, relative to the project) the same answers are 40-47 % smaller for searches and
 * outlines, and the code reads as code.
 *
 * Only the tools whose answer is mostly text are rendered here; anything else, and every error, goes through
 * `renderText` (llm-text.ts). A renderer returns undefined when the answer does not have the shape it knows, which
 * falls back the same way.
 */
import path from "node:path"

export interface RenderContext {
  /** The directory paths are shown relative to: the workspace the tool ran in. */
  root?: string | null
}

type Renderer = (data: any, ctx: RenderContext) => string | undefined

const rel = (file: unknown, root?: string | null): string => {
  const text = String(file ?? "")
  if (!root || !path.isAbsolute(text)) return text
  const relative = path.relative(root, text)
  return relative && !relative.startsWith("..") ? relative : text
}

const isObject = (data: unknown): data is Record<string, any> => !!data && typeof data === "object" && !Array.isArray(data)

const renderFsRead: Renderer = (data, ctx) => {
  if (!isObject(data) || data.ok !== true || typeof data.content !== "string") return undefined
  const header = `${rel(data.path, ctx.root)} (${data.linesRead ?? "?"} de ${data.totalLines ?? "?"} líneas)`
  const structure = Array.isArray(data.structure) && data.structure.length ? `\nEstructura del archivo:\n${data.structure.join("\n")}` : ""
  return `${header}\n${data.content}${structure}${data.note ? `\n[${data.note}]` : ""}`
}

const renderSearchInFiles: Renderer = (data, ctx) => {
  if (!isObject(data) || data.ok !== true || !Array.isArray(data.matches)) return undefined
  const byFile = new Map<string, string[]>()
  for (const match of data.matches) {
    const file = rel(match.file, ctx.root)
    byFile.set(file, [...(byFile.get(file) ?? []), `  ${match.line}: ${match.content}`])
  }
  const head = `${data.count ?? data.matches.length} coincidencia(s) de "${data.pattern ?? ""}"${data.truncated ? " (resultado truncado: afina el patrón o la ruta)" : ""}`
  return [head, ...[...byFile].map(([file, lines]) => `${file}\n${lines.join("\n")}`)].join("\n")
}

const renderOutline: Renderer = (data) => {
  if (!isObject(data) || data.ok !== true || !Array.isArray(data.symbols)) return undefined
  const lines = data.symbols.map((s: any) => `${s.lines} ${s.kind} ${s.signature ?? s.name}${s.exported ? " (export)" : ""}`)
  return [
    `${data.path}${data.stale ? " [el archivo cambió desde que se indexó: confírmalo en disco]" : ""}`,
    ...lines,
    ...(data.imports?.length ? [`importa: ${data.imports.join(", ")}`] : []),
  ].join("\n")
}

const renderFindSymbol: Renderer = (data) => {
  if (!isObject(data) || data.ok !== true || !Array.isArray(data.matches)) return undefined
  if (!data.matches.length) return data.note ?? `Sin coincidencias para "${data.name ?? ""}"`
  const lines = data.matches.map((m: any) => `${m.path}:${m.lines} ${m.kind} ${m.signature ?? m.name}${m.stale ? " [desactualizado]" : ""}`)
  return [`${data.total ?? data.matches.length} coincidencia(s) de "${data.name}"`, ...lines, ...(data.note ? [data.note] : [])].join("\n")
}

const renderList = (label: string, key: string): Renderer => (data) => {
  if (!isObject(data) || data.ok !== true || !Array.isArray(data[key])) return undefined
  return `${data.path} ${data.stale ? "[desactualizado] " : ""}— ${label}:\n${data[key].map((p: string) => `  ${p}`).join("\n") || "  (ninguno)"}`
}

const renderDependents: Renderer = (data, ctx) => {
  if (!isObject(data) || data.ok !== true || !Array.isArray(data.imported_by)) return undefined
  const total = data.imported_by_total ?? data.imported_by.length
  return [
    `${data.path}${data.stale ? " [desactualizado]" : ""}`,
    `lo importan (${total}${total > data.imported_by.length ? `, se muestran ${data.imported_by.length}` : ""}): ${data.imported_by.join(", ") || "nadie"}`,
    `importa (${data.imports_total ?? data.imports?.length ?? 0}): ${(data.imports ?? []).join(", ") || "nada"}`,
  ].join("\n")
}

const renderTestsFor: Renderer = (data) => {
  if (!isObject(data) || data.ok !== true) return undefined
  if (data.kind === "test") return `${data.path} (prueba) cubre: ${(data.covers ?? []).join(", ") || "nada indexado"}`
  if (!Array.isArray(data.tests)) return undefined
  return `${data.path}${data.stale ? " [desactualizado]" : ""}\npruebas: ${data.tests.join(", ") || "ninguna"}${data.note ? `\n${data.note}` : ""}`
}

const RENDERERS: Record<string, Renderer> = {
  fs_read: renderFsRead,
  search_in_files: renderSearchInFiles,
  outline: renderOutline,
  find_symbol: renderFindSymbol,
  dependents: renderDependents,
  tests_for: renderTestsFor,
}

/** The tool's answer as text, or undefined when it has no renderer or the answer is not the shape it knows. */
export function renderToolResult(toolName: string, data: unknown, ctx: RenderContext = {}): string | undefined {
  try { return RENDERERS[toolName]?.(data, ctx) } catch { return undefined }
}

export const renderedTools = (): string[] => Object.keys(RENDERERS)
