/**
 * The symbols of one source file, with the lines each one spans, for outline / find_symbol / read_range.
 *
 * Declarations are read from the top level only (column 0) plus the methods of a class, so a `const`
 * inside a function body never shows up as a symbol. A range ends where the next sibling begins (blank
 * and comment lines trimmed): exact for the usual one-declaration-after-another layout, approximate
 * when declarations are nested oddly.
 */

export interface SourceSymbol {
  name: string
  kind: string
  startLine: number
  endLine: number
  exported?: boolean
  /** The declaration line, trimmed: enough to tell what it takes and returns. */
  signature?: string
}

const TOP_LEVEL = /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+(\w+)/
const METHOD = /^ {2}(?:(?:public|private|protected|static|readonly|override|async|abstract)\s+)*(?:get\s+|set\s+)?(\w+)\s*[(<]/
const NOT_A_METHOD = new Set(["if", "for", "while", "switch", "return", "catch", "function", "constructor", "super", "await", "new", "typeof"])
const RUST_ITEM = /^(\s*)(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|mod)\s+(\w+)/

const clip = (line: string) => line.trim().replace(/\s*\{$/, "").slice(0, 140)

/** Last line of a symbol that starts at `start` and must stop before `limit` (exclusive): trailing blanks and comments dropped. */
function trimEnd(lines: string[], start: number, limit: number): number {
  let end = limit - 1
  while (end > start && /^\s*(?:$|\/\/|\/\*|\*)/.test(lines[end - 1])) end--
  return Math.max(start, end)
}

export function extractSymbols(source: string, ext: string): SourceSymbol[] {
  const lines = source.split("\n")
  return ext === "rs" ? rustSymbols(lines) : jsSymbols(lines)
}

function jsSymbols(lines: string[]): SourceSymbol[] {
  const tops: SourceSymbol[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = TOP_LEVEL.exec(lines[i])
    if (match) tops.push({ name: match[3], kind: match[2].replace("*", ""), startLine: i + 1, endLine: i + 1, exported: !!match[1], signature: clip(lines[i]) })
  }
  const result: SourceSymbol[] = []
  tops.forEach((top, n) => {
    top.endLine = trimEnd(lines, top.startLine, (tops[n + 1]?.startLine ?? lines.length + 1))
    result.push(top)
    if (top.kind !== "class") return
    const members: SourceSymbol[] = []
    for (let line = top.startLine + 1; line <= top.endLine; line++) {
      const m = METHOD.exec(lines[line - 1])
      if (m && !NOT_A_METHOD.has(m[1])) members.push({ name: `${top.name}.${m[1]}`, kind: "method", startLine: line, endLine: line, exported: top.exported, signature: clip(lines[line - 1]) })
    }
    members.forEach((member, k) => { member.endLine = trimEnd(lines, member.startLine, members[k + 1]?.startLine ?? top.endLine) })
    result.push(...members)
  })
  return result
}

function rustSymbols(lines: string[]): SourceSymbol[] {
  const items: SourceSymbol[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = RUST_ITEM.exec(lines[i])
    if (m && m[1].length === 0) items.push({ name: m[4], kind: m[3], startLine: i + 1, endLine: i + 1, exported: !!m[2], signature: clip(lines[i]) })
  }
  items.forEach((item, n) => { item.endLine = trimEnd(lines, item.startLine, items[n + 1]?.startLine ?? lines.length + 1) })
  return items
}
