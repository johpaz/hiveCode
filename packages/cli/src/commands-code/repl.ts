import * as readline from "node:readline"
import * as path from "node:path"
import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { logger } from "@johpaz/hive-code-core/utils/logger"
import {
  S, isCancel, hiveSelect
} from "../ui/index.ts"
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
  approval: `${C.bold}${C.amber}APROBACIÓN${C.reset}`,
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

// ─── Render helpers ─────────────────────────────────────────────────

let _promptRendered = false

function renderPrompt(status: ReplStatus, input: string): void {
  const sep = `${C.dim}  │  ${C.reset}`

  const items = [
    `${MODE_LABELS[status.mode]}  ${C.dim}[shift+tab]${C.reset}`,
    status.provider
      ? `${C.white}${status.provider}${C.reset}${status.model ? ` · ${status.model}` : ""}`
      : `${C.dim}sin provider${C.reset}`,
    `${C.dim}^C salir${C.reset}`,
    `${C.dim}:help${C.reset}`,
    `ctx: ${status.taskCount}`,
    `${fmtTokens(status.tokenCount)} tok`,
  ]

  const barLine = `  ${C.dim}│${C.reset}  ${items.join(sep)}`
  const promptLine = `  ${C.amber}${S.active}${C.reset}  ${C.white}¿Qué quieres construir?${C.reset}  ${input || C.dim + "describe la tarea..." + C.reset}`

  if (_promptRendered) {
    process.stdout.write(`\x1b[2A\r${C.clearLine}${barLine}\n${C.clearLine}${promptLine}`)
  } else {
    process.stdout.write(`\n${barLine}\n${promptLine}`)
    _promptRendered = true
  }
}

// ─── Input handler ──────────────────────────────────────────────────

function getInput(status: ReplStatus): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()

    let buffer = ""
    let escSeq: string | null = null
    _promptRendered = false
    renderPrompt(status, "")

    function onData(data: Buffer) {
      for (let i = 0; i < data.length; i++) {
        const byte = data[i]

        if (escSeq !== null) {
          escSeq += String.fromCharCode(byte)
          if (byte >= 0x40 && byte <= 0x7e) {
            if (escSeq === "\x1b[Z") {
              const idx = MODE_CYCLE.indexOf(status.mode)
              status.mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]
              saveMode(status.mode)
              renderPrompt(status, buffer)
            } else if (escSeq === "\x1b" || escSeq.length > 4) {
              cleanup(); resolve(null); return
            }
            escSeq = null
          }
          continue
        }

        if (byte === 0x03 || byte === 0x04) {
          cleanup(); resolve(null); return
        }

        if (byte === 0x0d || byte === 0x0a) {
          cleanup()
          process.stdout.write("\n")
          resolve(buffer)
          return
        }

        if (byte === 0x7f || byte === 0x08) {
          buffer = buffer.slice(0, -1)
          renderPrompt(status, buffer)
          continue
        }

        if (byte === 0x1b) {
          escSeq = "\x1b"
          continue
        }

        if (byte >= 0x20 && byte <= 0x7e) {
          buffer += String.fromCharCode(byte)
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

// ─── Command handlers ──────────────────────────────────────────────

function showHelp(): void {
  process.stdout.write(
    `\n  ${C.amber}${S.info}${C.reset}  ${C.bold}Comandos del REPL${C.reset}\n` +
    `  ${C.dim}│${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}:help${C.reset}      ${C.dim}Mostrar esta ayuda${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}:mode${C.reset}       ${C.dim}Cambiar al siguiente modo${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}:mode <m>${C.reset}   ${C.dim}plan | approval | auto${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}:status${C.reset}     ${C.dim}Estado actual del sistema${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}:clear${C.reset}      ${C.dim}Limpiar pantalla${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}:exit${C.reset}       ${C.dim}Salir del REPL${C.reset}\n` +
    `  ${C.dim}│${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${C.bold}Cada tarea se ejecuta según el modo activo:${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${MODE_COLORS.plan}PLAN${C.reset}        ${C.dim}Solo diseña, no modifica archivos${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${MODE_COLORS.approval}APROBACIÓN${C.reset}  ${C.dim}Plan + confirmación antes de implementar${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${MODE_COLORS.auto}AUTO${C.reset}        ${C.dim}Ejecuta todo automáticamente${C.reset}\n` +
    `  ${C.dim}│${C.reset}\n`
  )
}

function showStatus(s: ReplStatus): void {
  const gh = s.ghConnected
    ? `${C.green}✓${C.reset} conectado`
    : `${C.dim}—${C.reset}`
  process.stdout.write(
    `\n  ${C.amber}${S.info}${C.reset}  ${C.bold}Estado del sistema${C.reset}\n` +
    `  ${C.dim}│${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}Modo:${C.reset}      ${MODE_COLORS[s.mode]}${s.mode.toUpperCase()}${C.reset}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}Provider:${C.reset}  ${s.provider || "ninguno"}${s.model ? ` · ${s.model}` : ""}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}GitHub:${C.reset}    ${gh}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}Proyecto:${C.reset}  ${s.projectPath}\n` +
    `  ${C.dim}│${C.reset}    ${C.white}Tareas:${C.reset}    ${s.taskCount} activas\n` +
    `  ${C.dim}│${C.reset}    ${C.white}Tokens:${C.reset}    ${fmtTokens(s.tokenCount)}\n` +
    `  ${C.dim}│${C.reset}\n`
  )
}

async function handleCommand(input: string, status: ReplStatus): Promise<"continue" | "exit"> {
  const cmd = input.slice(1).toLowerCase().trim()

  if (cmd === "exit" || cmd === "q" || cmd === "quit") return "exit"
  if (cmd === "help" || cmd === "h") { showHelp(); return "continue" }
  if (cmd === "clear" || cmd === "cls") { console.clear(); return "continue" }
  if (cmd === "status" || cmd === "st") { showStatus(status); return "continue" }

  if (cmd === "mode" || cmd === "m") {
    const idx = MODE_CYCLE.indexOf(status.mode)
    status.mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]
    saveMode(status.mode)
    process.stdout.write(`  ${C.amber}${S.info}${C.reset}  Modo: ${MODE_LABELS[status.mode]}\n`)
    return "continue"
  }

  if (cmd.startsWith("mode ")) {
    const newMode = cmd.slice(5).trim() as Mode
    if (MODE_CYCLE.includes(newMode)) {
      status.mode = newMode
      saveMode(newMode)
      process.stdout.write(`  ${C.amber}${S.info}${C.reset}  Modo: ${MODE_LABELS[newMode]}\n`)
    } else {
      process.stdout.write(`  ${C.red}${S.error}${C.reset}  Modo inválido. Usa: plan, approval, auto\n`)
    }
    return "continue"
  }

  process.stdout.write(`  ${C.red}${S.error}${C.reset}  Comando desconocido: :${cmd}\n`)
  process.stdout.write(`  ${C.dim}│${C.reset}  Usa ${C.white}:help${C.reset} para ver comandos disponibles\n`)
  return "continue"
}

// ─── Task execution ────────────────────────────────────────────────

async function executeTask(task: string, status: ReplStatus): Promise<void> {
  if (status.mode === "plan") {
    await plan(task)
  } else if (status.mode === "auto") {
    await run(task, [])
  } else {
    await plan(task)

    const approval = await hiveSelect({
      message: "¿Deseas implementar este plan?",
      options: [
        { value: "yes", label: "Sí, implementar" },
        { value: "no", label: "No, volver" },
      ],
    })

    if (isCancel(approval) || approval === "no") {
      process.stdout.write(`  ${C.amber}${S.barEnd}${C.reset}  ${C.dim}Implementación omitida${C.reset}\n`)
      return
    }

    await run(task, [])
  }
}

// ─── Main export ───────────────────────────────────────────────────

export async function repl(): Promise<void> {
  const status = loadStatus()
  const projectName = path.basename(status.projectPath)

  process.stdout.write(
    `\n  ${S.bee}  ${C.bold}${C.amber}hive-code v${VERSION}${C.reset} · ${C.white}${projectName}${C.reset}\n` +
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

    if (trimmed.startsWith(":")) {
      const result = await handleCommand(trimmed, status)
      if (result === "exit") break
      continue
    }

    try {
      await executeTask(trimmed, status)
    } catch (err) {
      logger.error("[repl] Task execution error:", err)
      process.stdout.write(`  ${C.red}${S.error}${C.reset}  ${(err as Error).message}\n`)
    }
  }

  process.stdout.write(`  ${C.amber}${S.barEnd}${C.reset}  ${C.green}${S.check}${C.reset}  Hasta luego\n\n`)
}
