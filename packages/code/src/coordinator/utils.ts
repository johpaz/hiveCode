import type { BeeDecision } from "../workers/types"

// ── JSON repair ───────────────────────────────────────────────────────────────

export function repairJson(input: string): string | null {
  let s = input.trim()
  s = s.replace(/,\s*([}\]])/g, "$1")
  const opens = (s.match(/{/g) || []).length
  const closes = (s.match(/}/g) || []).length
  if (opens > closes) s += "}".repeat(opens - closes)
  const openBrackets = (s.match(/\[/g) || []).length
  const closeBrackets = (s.match(/]/g) || []).length
  if (openBrackets > closeBrackets) s += "]".repeat(openBrackets - closeBrackets)
  return s
}

// ── BEE decision parser ───────────────────────────────────────────────────────

function extractDecisionFields(data: Record<string, unknown>): BeeDecision {
  return {
    action: (data.action as BeeDecision["action"]) || "architecture",
    content: data.content as string | undefined,
    reason: (data.reason as string) || "",
    phases: data.phases as BeeDecision["phases"],
    filesModified: data.filesModified as string[] | undefined,
    harness: data.harness as string | undefined,
  }
}

export function parseBeeDecision(raw: string): BeeDecision {
  if (!raw || !raw.trim()) {
    return { action: "respond", content: "", reason: "Empty response from LLM" }
  }

  // Strategy 1: markdown code block
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (codeBlockMatch) {
    try { return extractDecisionFields(JSON.parse(codeBlockMatch[1])) } catch { /* fallthrough */ }
    const repaired = repairJson(codeBlockMatch[1])
    if (repaired) {
      try { return extractDecisionFields(JSON.parse(repaired)) } catch { /* fallthrough */ }
    }
  }

  // Strategy 2: inline JSON object with "action" key
  const jsonObjMatch = raw.match(/\{[\s\S]*"action"[\s\S]*\}/)
  if (jsonObjMatch) {
    try { return extractDecisionFields(JSON.parse(jsonObjMatch[0])) } catch { /* fallthrough */ }
    const repaired = repairJson(jsonObjMatch[0])
    if (repaired) {
      try { return extractDecisionFields(JSON.parse(repaired)) } catch { /* fallthrough */ }
    }
  }

  // Strategy 3: entire response as JSON
  try { return extractDecisionFields(JSON.parse(raw)) } catch { /* fallthrough */ }

  // Strategy 4: plain text — treat as direct response
  return { action: "respond", content: raw.trim(), reason: "BEE returned non-JSON response" }
}

export function formatBeeNarrative(raw: string): string {
  const decision = parseBeeDecision(raw)
  switch (decision.action) {
    case "respond":    return decision.content || "BEE respondió directamente."
    case "fix":        return decision.content || "BEE aplicó un fix directo."
    case "dispatch": {
      const coords = decision.phases?.map(p => p.coordinator).join(", ") || ""
      return `BEE delegó a: ${coords}\n${decision.reason}`
    }
    case "architecture": return `BEE decidió diseño arquitectónico\n${decision.reason}`
    default:             return raw
  }
}

// ── Tool formatting ───────────────────────────────────────────────────────────

export function formatToolCallForHuman(toolName: string, args: Record<string, unknown>): string {
  const path  = (args.path as string)    || (args.file as string)    || ""
  const cmd   = (args.cmd as string)     || (args.command as string) || ""
  const query = (args.query as string)   || (args.pattern as string) || ""
  switch (toolName) {
    case "fs_read":          return `📄 Leyendo archivo${path ? ": " + path : ""}`
    case "fs_list":          return `📁 Explorando directorio${path ? ": " + path : ""}`
    case "fs_exists":        return `🔍 Verificando existencia${path ? ": " + path : ""}`
    case "fs_glob":          return `🌐 Buscando archivos${args.pattern ? ": " + args.pattern : ""}`
    case "fs_write":         return `✏️  Escribiendo archivo${path ? ": " + path : ""}`
    case "fs_edit":          return `✏️  Editando archivo${path ? ": " + path : ""}`
    case "fs_delete":        return `🗑️  Eliminando archivo${path ? ": " + path : ""}`
    case "shell_executor":   return `⚡ Ejecutando${cmd ? ": " + cmd.slice(0, 60) : ""}`
    case "code_search":      return `🔍 Buscando código${query ? ": " + query.slice(0, 60) : ""}`
    case "parse_ast":        return `🌳 Analizando AST${path ? ": " + path : ""}`
    case "git_status":       return `📊 Estado del repositorio`
    case "git_diff":         return `📋 Diff del repositorio`
    case "git_log":          return `📜 Historial de commits`
    case "git_branch":       return `🌿 Gestionando ramas`
    case "git_commit":       return `💾 Commit de cambios`
    case "check_types":      return `🔎 Verificando tipos`
    case "code_build":       return `🏗️  Compilando proyecto`
    case "code_test":        return `🧪 Ejecutando tests`
    case "code_lint":        return `🧹 Linting`
    case "read_narrative":   return `📖 Leyendo narrativa`
    case "write_decision":   return `📝 Registrando decisión`
    case "append_narrative": return `📝 Actualizando narrativa`
    case "run_script":       return `▶️  Ejecutando script`
    case "browser_screenshot": return `🖼️  Capturando pantalla${args.url ? ": " + args.url : ""}`
    case "web_search":       return `🌐 Buscando web${query ? ": " + query.slice(0, 60) : ""}`
    case "web_fetch":        return `🌐 Fetching${args.url ? ": " + args.url : ""}`
    default:                 return `🔧 ${toolName}`
  }
}

const MAX_DISPLAY_CHARS = 10_000
const MAX_DISPLAY_LINES = 500

export function smartTruncate(text: string, maxChars = MAX_DISPLAY_CHARS): string {
  if (text.length <= maxChars) return text
  const headLen = Math.floor(maxChars * 0.3)
  const tailLen = Math.floor(maxChars * 0.7)
  return text.slice(0, headLen) + `\n... [${text.length - headLen - tailLen} chars omitted] ...\n` + text.slice(-tailLen)
}

export function smartTruncateLines(text: string, maxLines = MAX_DISPLAY_LINES): string {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return text
  const headLines = Math.floor(maxLines * 0.3)
  const tailLines = Math.floor(maxLines * 0.7)
  return (
    lines.slice(0, headLines).join("\n") +
    `\n... [${lines.length - headLines - tailLines} lines omitted] ...\n` +
    lines.slice(-tailLines).join("\n")
  )
}

export function formatToolResult(toolName: string, result: unknown): string {
  const r = result as any
  const isError = r && typeof r === "object" && "ok" in r && r.ok === false
  if (isError) return `<system>\n❌ [${toolName}]: ${r.error || "Unknown error"}\n</system>`

  let summary = ""
  switch (toolName) {
    case "fs_list": {
      const count = r?.count ?? r?.entries?.length ?? 0
      summary = `✅ [${toolName}]: ${count} entries in ${r?.path || "."}`
      if (r?.entries?.length) {
        const lines = r.entries.map((e: any) => {
          const isDir = e.type === "directory"
          let size = ""
          if (!isDir && e.size != null) {
            if (e.size >= 1_048_576) size = ` (${(e.size / 1_048_576).toFixed(1)}MB)`
            else if (e.size >= 1024) size = ` (${Math.round(e.size / 1024)}KB)`
            else if (e.size > 0)    size = ` (${e.size}B)`
          }
          return `  ${isDir ? "📁" : "📄"} ${e.name}${size}`
        })
        summary += "\n" + smartTruncateLines(lines.join("\n"))
      }
      break
    }
    case "fs_read": {
      summary = `✅ [${toolName}]: ${r?.path || "file"} (${r?.linesRead ?? 0}/${r?.totalLines ?? 0} lines)`
      if (r?.content) summary += "\n```\n" + smartTruncate(String(r.content)) + "\n```"
      break
    }
    case "fs_exists": {
      summary = `✅ [${toolName}]: ${r?.path || ""} ${r?.exists ? "exists" : "does not exist"}`
      break
    }
    case "fs_glob": {
      const matches = r?.matches || r?.files || []
      summary = `✅ [${toolName}]: ${matches.length} matches${r?.pattern ? ` for "${r.pattern}"` : ""}`
      if (matches.length > 0) summary += "\n" + smartTruncateLines(matches.map((f: string) => `  ${f}`).join("\n"))
      break
    }
    case "shell_executor": {
      const exit = r?.exitCode ?? 0
      summary = `${exit === 0 ? "✅" : "⚠️"} [${toolName}]: ${r?.command || ""} (exit=${exit}, ${r?.executionTimeMs ?? 0}ms)`
      if (r?.stdout) summary += "\nstdout:\n```\n" + smartTruncate(smartTruncateLines(String(r.stdout))) + "\n```"
      if (r?.stderr) summary += "\nstderr:\n```\n" + smartTruncate(smartTruncateLines(String(r.stderr))) + "\n```"
      break
    }
    case "code_search": {
      const matches = r?.matches || []
      summary = `✅ [${toolName}]: ${matches.length} matches${r?.query ? ` for "${r.query}"` : ""}`
      if (matches.length > 0) summary += "\n" + smartTruncateLines(matches.map((m: any) => `  ${m.file}:${m.line}: ${m.text || ""}`).join("\n"))
      break
    }
    case "git_status": {
      const staged = r?.staged || [], unstaged = r?.unstaged || []
      summary = `✅ [${toolName}]: ${staged.length} staged, ${unstaged.length} unstaged`
      if (staged.length)   summary += "\nstaged:\n"   + staged.map((f: string)   => `  ${f}`).join("\n")
      if (unstaged.length) summary += "\nunstaged:\n" + unstaged.map((f: string) => `  ${f}`).join("\n")
      break
    }
    case "git_diff": {
      summary = `✅ [${toolName}]: diff retrieved${r?.path ? ` for ${r.path}` : ""}`
      if (r?.diff) summary += "\n```diff\n" + smartTruncate(smartTruncateLines(String(r.diff))) + "\n```"
      break
    }
    case "git_log": {
      const commits = r?.commits || []
      summary = `✅ [${toolName}]: ${commits.length} commits`
      if (commits.length > 0) summary += "\n" + commits.map((c: any) => `  ${c.hash?.slice(0, 7) || ""} — ${c.message || ""}`).join("\n")
      break
    }
    case "parse_ast": {
      summary = `✅ [${toolName}]: AST parsed for ${r?.file || r?.path || "file"}`
      if (r?.summary) summary += `\n${r.summary}`
      break
    }
    case "check_types": {
      summary = `${r?.ok ? "✅" : "⚠️"} [${toolName}]: type check ${r?.ok ? "passed" : "failed"}`
      if (r?.errors?.length) summary += "\n" + r.errors.map((e: string) => `  ${e}`).join("\n")
      break
    }
    case "code_build":
    case "code_test":
    case "code_lint": {
      summary = `${r?.ok ? "✅" : "⚠️"} [${toolName}]: ${r?.ok ? "success" : "failed"}`
      if (r?.output) summary += "\n```\n" + smartTruncate(smartTruncateLines(String(r.output))) + "\n```"
      break
    }
    case "browser_screenshot": {
      summary = `${r?.ok ? "✅" : "❌"} [${toolName}]: ${r?.url || ""}`
      if (r?.path)  summary += `\nScreenshot saved to: ${r.path}`
      if (r?.error) summary += `\nError: ${r.error}`
      break
    }
    case "web_search": {
      const results = r?.results || []
      summary = `✅ [${toolName}]: ${results.length} results${r?.query ? ` for "${r.query}"` : ""}`
      if (results.length > 0) {
        summary += "\n" + results.map((res: any, i: number) =>
          `  ${i + 1}. ${res.title || ""}\n     ${res.url || ""}\n     ${res.snippet || ""}`
        ).join("\n")
      }
      break
    }
    case "web_fetch": {
      summary = `✅ [${toolName}]: fetched ${r?.url || ""}`
      if (r?.title)   summary += `\nTitle: ${r.title}`
      if (r?.content) summary += "\n```\n" + smartTruncate(String(r.content)) + "\n```"
      break
    }
    default: {
      const generic = typeof result === "string" ? result : JSON.stringify(result, null, 2)
      summary = `✅ [${toolName}]: result\n\`\`\`\n${smartTruncate(generic)}\n\`\`\``
    }
  }

  return `<system>\n${summary}\n</system>`
}

// ── Git diff parser ───────────────────────────────────────────────────────────

export function parseGitDiffStat(stat: string): Record<string, { added: number; removed: number }> {
  const result: Record<string, { added: number; removed: number }> = {}
  for (const line of stat.split("\n")) {
    const m = line.match(/^\s+(.+?)\s+\|\s+\d+\s+([+\-]+)/)
    if (!m) continue
    result[m[1].trim()] = {
      added:   (m[2].match(/\+/g) ?? []).length,
      removed: (m[2].match(/-/g)  ?? []).length,
    }
  }
  return result
}

export interface DiffChunk {
  kind: "add" | "remove" | "context"
  text: string
  old_line_no?: number
  new_line_no?: number
}

export function parseUnifiedDiff(diffText: string): DiffChunk[] {
  const chunks: DiffChunk[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of diffText.split("\n")) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10)
      newLine = parseInt(hunkMatch[2], 10)
      continue
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) continue

    if (line.startsWith("+")) {
      chunks.push({ kind: "add", text: line.slice(1), new_line_no: newLine++ })
    } else if (line.startsWith("-")) {
      chunks.push({ kind: "remove", text: line.slice(1), old_line_no: oldLine++ })
    } else if (line.startsWith(" ")) {
      chunks.push({ kind: "context", text: line.slice(1), old_line_no: oldLine++, new_line_no: newLine++ })
    }
  }
  return chunks
}
