import * as path from "node:path"
import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { logger } from "@johpaz/hive-code-core/utils/logger"
import {
  BEE, S, isCancel, hiveSelect
} from "../ui/index.ts"
import { parseInternalCommand, renderHelp, getCtx } from "@johpaz/hive-code-code/coordinator/command-parser"
import { plan } from "./plan"
import { run } from "./run"

const VERSION = "1.0.0"

const C = {
  amber:      "\x1b[38;5;214m",
  amberDim:   "\x1b[38;5;172m",
  green:      "\x1b[38;5;114m",
  red:        "\x1b[38;5;203m",
  purple:     "\x1b[38;5;141m",
  white:      "\x1b[38;5;252m",
  dim:        "\x1b[2m",
  bold:       "\x1b[1m",
  reset:      "\x1b[0m",
  clearLine:  "\x1b[2K\r",
}

const MODE_CYCLE = ["plan", "approval", "auto"] as const
type Mode = (typeof MODE_CYCLE)[number]

const MODE_COLORS: Record<Mode, string> = {
  plan:     C.purple,
  approval: C.amber,
  auto:     C.green,
}

const MODE_LABELS: Record<Mode, string> = {
  plan:     `${C.bold}${C.purple}PLAN${C.reset}`,
  approval: `${C.bold}${C.amber}APROBACI\u00d3N${C.reset}`,
  auto:     `${C.bold}${C.green}AUTO${C.reset}`,
}

interface ReplStatus {
  mode: Mode
  provider: string
  model: string
  ghConnected: boolean
  projectPath: string
  taskCount: number
  tokenCount: number
}

function loadStatus(): ReplStatus {
  const db = getDb()
  const m = (db.query("SELECT value FROM code_config WHERE key = 'default_mode'").get() as any)?.value
  const mode: Mode = m === "auto" ? "auto" : m === "approval" ? "approval" : "plan"
  const provider = (db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get() as any)?.value ?? ""
  const model = provider ? (db.query("SELECT value FROM code_config WHERE key = ?").get(`provider_model_${provider}`) as any)?.value ?? "" : ""
  const ghConnected = !!(db.query("SELECT value FROM code_config WHERE key = 'github_token'").get() as any)?.value
  const projectPath = (db.query("SELECT project_path FROM code_sessions ORDER BY id DESC LIMIT 1").get() as any)?.project_path ?? process.cwd()
  const taskCount = (db.query("SELECT COUNT(*) as c FROM code_tasks WHERE status NOT IN ('cancelled','completed')").get() as any)?.c ?? 0
  const tokenCount = (db.query("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as t FROM code_traces").get() as any)?.t ?? 0
  return { mode, provider, model, ghConnected, projectPath, taskCount, tokenCount }
}

function saveMode(m: string): void {
  try { getDb().query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_mode', ?)").run(m) } catch {}
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

let _promptRendered = false

function renderPrompt(status: ReplStatus, input: string): void {
  const sep = `${C.dim}  \u2502  ${C.reset}`

  const items = [
    `${MODE_LABELS[status.mode]}  ${C.dim}[shift+tab]${C.reset}`,
    status.provider
      ? `${C.white}${status.provider}${C.reset}${status.model ? ` \u00b7 ${status.model}` : ""}`
      : `${C.dim}sin provider${C.reset}`,
    `${C.dim}^C salir${C.reset}`,
    `${C.dim}/help${C.reset}`,
    `ctx: ${status.taskCount}`,
    `${fmtTokens(status.tokenCount)} tok`,
  ]

  const barLine = `  ${C.dim}\u2502${C.reset}  ${items.join(sep)}`
  const beeIcon = input.startsWith("/") ? BEE.happy : BEE.waiting
  const promptLine = `  ${beeIcon}  ${C.white}\u00bfQu\u00e9 quieres construir?${C.reset}  ${input || C.dim + "describe la tarea o escribe /help..." + C.reset}`

  if (_promptRendered) {
    process.stdout.write(`\x1b[2A\r${C.clearLine}${barLine}\n${C.clearLine}${promptLine}`)
  } else {
    process.stdout.write(`\n${barLine}\n${promptLine}`)
    _promptRendered = true
  }
}

type InputState = "normal" | "esc" | "csi"

function getInput(status: ReplStatus): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()

    let buffer = ""
    let state: InputState = "normal"
    let csiBuf = ""
    let suggestions: string[] = []
    let suggestionIdx = -1
    _promptRendered = false
    renderPrompt(status, "")

    function getSuggestions(prefix: string): string[] {
      if (!prefix.startsWith("/") || prefix.length < 2) return []
      const db = getDb()
      try {
        const search = prefix.slice(1).toLowerCase().replace(/[^a-z0-9_\/\s-]/g, "")
        const rows = db.query(`
          SELECT command FROM code_commands_fts
          WHERE command MATCH ?
          ORDER BY rank
          LIMIT 5
        `).all(search) as { command: string }[]
        return rows.map(r => r.command)
      } catch {
        return []
      }
    }

    function onData(data: Buffer) {
      for (let i = 0; i < data.length; i++) {
        const byte = data[i]

        if (state === "esc") {
          state = byte === 0x5b ? "csi" : "normal"
          if (state === "csi") { csiBuf = ""; continue }
          continue
        }

        if (state === "csi") {
          if (byte >= 0x40 && byte <= 0x7e) {
            state = "normal"
            if (csiBuf === "" && byte === 0x5a) {
              // Shift+Tab: cycle mode
              const idx = MODE_CYCLE.indexOf(status.mode)
              status.mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]
              saveMode(status.mode)
              renderPrompt(status, buffer)
            } else if (csiBuf === "A") {
              // Up arrow: previous suggestion
              if (suggestions.length > 0) {
                suggestionIdx = Math.max(0, suggestionIdx - 1)
                buffer = suggestions[suggestionIdx]
                renderPrompt(status, buffer)
              }
            } else if (csiBuf === "B") {
              // Down arrow: next suggestion
              if (suggestions.length > 0) {
                suggestionIdx = Math.min(suggestions.length - 1, suggestionIdx + 1)
                buffer = suggestions[suggestionIdx]
                renderPrompt(status, buffer)
              }
            } else if (csiBuf === "" && byte === 0x49) {
              // Tab: autocomplete
              if (buffer.startsWith("/")) {
                const sugg = getSuggestions(buffer)
                if (sugg.length === 1) {
                  buffer = sugg[0] + " "
                  renderPrompt(status, buffer)
                } else if (sugg.length > 1) {
                  suggestions = sugg
                  suggestionIdx = -1
                }
              }
            }
            continue
          }
          csiBuf += String.fromCharCode(byte)
          if (csiBuf.length > 16) state = "normal"
          continue
        }

        if (byte === 0x1b) { state = "esc"; continue }
        if (byte === 0x03 || byte === 0x04) { cleanup(); resolve(null); return }
        if (byte === 0x09) {
          // Tab: autocomplete
          if (buffer.startsWith("/")) {
            const sugg = getSuggestions(buffer)
            if (sugg.length === 1) {
              buffer = sugg[0] + " "
              renderPrompt(status, buffer)
            } else if (sugg.length > 1) {
              suggestions = sugg
              suggestionIdx = -1
            }
          }
          continue
        }
        if (byte === 0x0d || byte === 0x0a) {
          cleanup()
          process.stdout.write("\n")
          resolve(buffer)
          return
        }
        if (byte === 0x7f || byte === 0x08) {
          buffer = buffer.slice(0, -1)
          suggestions = []
          suggestionIdx = -1
          renderPrompt(status, buffer)
          continue
        }
        if (byte >= 0x20 && byte <= 0x7e) {
          buffer += String.fromCharCode(byte)
          suggestions = []
          suggestionIdx = -1
          renderPrompt(status, buffer)
        }
      }
    }

    function cleanup() {
      stdin.removeListener("data", onData)
      stdin.setRawMode(false)
    }

    stdin.on("data", onData)
  })
}

function showStatus(s: ReplStatus): void {
  const gh = s.ghConnected
    ? `${C.green}\u2713${C.reset} conectado`
    : `${C.dim}\u2014${C.reset}`
  process.stdout.write(
    `\n  ${S.info}  ${C.bold}Estado del sistema${C.reset}\n` +
    `  ${C.dim}\u2502${C.reset}\n` +
    `  ${C.dim}\u2502${C.reset}    ${C.white}Modo:${C.reset}      ${MODE_COLORS[s.mode]}${s.mode.toUpperCase()}${C.reset}\n` +
    `  ${C.dim}\u2502${C.reset}    ${C.white}Provider:${C.reset}  ${s.provider || "ninguno"}${s.model ? ` \u00b7 ${s.model}` : ""}\n` +
    `  ${C.dim}\u2502${C.reset}    ${C.white}GitHub:${C.reset}    ${gh}\n` +
    `  ${C.dim}\u2502${C.reset}    ${C.white}Proyecto:${C.reset}  ${s.projectPath}\n` +
    `  ${C.dim}\u2502${C.reset}    ${C.white}Tareas:${C.reset}    ${s.taskCount} activas\n` +
    `  ${C.dim}\u2502${C.reset}    ${C.white}Tokens:${C.reset}    ${fmtTokens(s.tokenCount)}\n` +
    `  ${C.dim}\u2502${C.reset}\n`
  )
}

async function handleCommand(input: string, status: ReplStatus): Promise<"continue" | "exit"> {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return "continue"

  const db = getDb()
  const ctx = getCtx(db)

  if (trimmed === "/exit" || trimmed === "/q" || trimmed === "/quit") return "exit"
  if (trimmed === "/clear" || trimmed === "/cls") { console.clear(); return "continue" }

  const result = await parseInternalCommand(trimmed, db, {
    ...ctx,
    activeMode: status.mode,
    activeProvider: status.provider,
    activeModel: status.model,
  })

  if (result.output) {
    process.stdout.write(`${result.output}\n`)
  }

  if (result.newState) {
    if (result.newState.activeMode) status.mode = result.newState.activeMode
    if (result.newState.activeProvider) status.provider = result.newState.activeProvider
    if (result.newState.activeModel) status.model = result.newState.activeModel
  }

  return "continue"
}

async function executeTask(task: string, status: ReplStatus): Promise<void> {
  if (status.mode === "plan") {
    await plan(task)
  } else if (status.mode === "auto") {
    await run(task, [])
  } else {
    await plan(task)

    const approval = await hiveSelect({
      message: "\u00bfDeseas implementar este plan?",
      options: [
        { value: "yes", label: "S\u00ed, implementar" },
        { value: "no", label: "No, volver" },
      ],
    })

    if (isCancel(approval) || approval === "no") {
      process.stdout.write(`  ${C.amber}${S.barEnd}${C.reset}  ${C.dim}Implementaci\u00f3n omitida${C.reset}\n`)
      return
    }

    await run(task, [])
  }
}

export async function repl(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log("REPL requires a TTY. Use 'hive-code <command>' for non-interactive mode.")
    return
  }

  const status = loadStatus()
  const projectName = path.basename(status.projectPath)

  process.stdout.write(
    `\n  ${BEE.happy}  ${C.bold}${C.amber}hive-code v${VERSION}${C.reset} \u00b7 ${C.white}${projectName}${C.reset}\n` +
    `  ${C.amber}${S.bar}${C.reset}\n`
  )

  while (true) {
    try {
      status.taskCount = (getDb().query("SELECT COUNT(*) as c FROM code_tasks WHERE status NOT IN ('cancelled','completed')").get() as any)?.c ?? 0
      status.tokenCount = (getDb().query("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as t FROM code_traces").get() as any)?.t ?? 0
    } catch {}

    const task = await getInput(status)
    if (task === null) break

    const trimmed = task.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("/")) {
      const result = await handleCommand(trimmed, status)
      if (result === "exit") break
      continue
    }

    try {
      await executeTask(trimmed, status)
    } catch (err) {
      logger.error("[repl] Task execution error:", err)
      process.stdout.write(`  ${BEE.error}  ${(err as Error).message}\n`)
    }
  }

  process.stdout.write(`  ${C.amber}${S.barEnd}${C.reset}  ${C.green}${S.check}${C.reset}  Hasta luego\n\n`)
}
