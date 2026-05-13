import * as path from "node:path"
import { createInterface } from "node:readline/promises"
import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { logger } from "@johpaz/hive-code-core/utils/logger"
import {
  BEE, S, C, isCancel, hiveSelect, hiveNote, hiveOutro,
  runProviderSetupWizard,
} from "@johpaz/hive-code-ui"
import { parseInternalCommand, getCtx } from "@johpaz/hive-code-code/coordinator/command-parser"
import { plan as runPlan } from "./plan"
import { run as runTask } from "./run"

const VERSION = "1.0.0"



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

function buildStatusBar(status: ReplStatus): string {
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
  return `  ${C.dim}\u2502${C.reset}  ${items.join(sep)}`
}



function completer(line: string): [string[], string] {
  if (!line.startsWith("/") || line.length < 2) return [[], line]
  const search = line.slice(1).toLowerCase().replace(/[^a-z0-9_/\s-]/g, "")
  const db = getDb()
  try {
    const rows = db.query(`
      SELECT command FROM code_commands_fts
      WHERE command MATCH ?
      ORDER BY rank
      LIMIT 5
    `).all(search + "*") as { command: string }[]
    const hits = rows.map(r => "/" + r.command)
    return [hits, line]
  } catch {
    return [[], line]
  }
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
  // Guard: sin provider configurado no se puede ejecutar ninguna tarea
  if (!status.provider) {
    hiveNote("Sin provider configurado", [
      "Necesitas un provider LLM para ejecutar tareas.",
      "Configura uno ahora o usa: hive-code provider add",
    ])
    const choice = await hiveSelect({
      message: "¿Qué deseas hacer?",
      options: [
        { value: "setup", label: "Configurar provider ahora" },
        { value: "cancel", label: "Cancelar tarea" },
      ],
    })
    if (isCancel(choice) || choice === "cancel") return

    const db = getDb()
    const knownProviders = (
      db.query("SELECT id FROM providers ORDER BY id").all() as { id: string }[]
    ).map((r) => r.id)

    const result = await runProviderSetupWizard(knownProviders)
    if (!result) return

    db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_provider', ?)").run(
      result.provider
    )
    if (result.model) {
      db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)").run(
        `provider_model_${result.provider}`,
        result.model
      )
    }
    try {
      const secrets = (Bun as any).secrets
      if (secrets?.set)
        secrets.set(
          `${result.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`,
          result.apiKey
        )
    } catch {
      db.query("UPDATE providers SET api_key_encrypted = ? WHERE id = ?").run(
        Buffer.from(result.apiKey).toString("base64"),
        result.provider
      )
    }
    status.provider = result.provider
    status.model = result.model || ""
    hiveOutro(`Provider ${result.provider} configurado`)
  }

  if (status.mode === "plan") {
    await runPlan(task, { keyboard: false })
  } else if (status.mode === "auto") {
    await runTask(task, [], { keyboard: false })
  } else {
    await runPlan(task, { keyboard: false })
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
    await runTask(task, [], { keyboard: false })
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

  // Shift+Tab: cycle mode (persists across readline instances)
  const handleShiftTab = (_str: unknown, key: unknown) => {
    const k = key as { name?: string; shift?: boolean } | null
    if (k?.name === "tab" && k?.shift) {
      const idx = MODE_CYCLE.indexOf(status.mode)
      status.mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]
      saveMode(status.mode)
    }
  }
  process.stdin.on("keypress", handleShiftTab)

  let sigintCount = 0
  let rl: ReturnType<typeof createInterface> | null = null

  function closeRL() {
    if (!rl) return
    rl.close()
    rl.removeAllListeners()
    rl = null
  }

  function createRL() {
    closeRL()
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      completer,
    })

    rl.on("SIGINT", () => {
      sigintCount++
      process.stdout.write(C.clearLine)
      if (sigintCount >= 2) {
        closeRL()
        process.stdin.removeListener("keypress", handleShiftTab)
        process.stdout.write(`\n ${C.amber}${S.barEnd}${C.reset} ${C.green}${S.check}${C.reset} Hasta luego\n\n`)
        process.exit(0)
      }
      setTimeout(() => { sigintCount = 0 }, 2000)
      process.stdout.write(`\n${C.dim} [Ctrl+C otra vez para salir]${C.reset}\n`)
      rl?.prompt(true)
    })

    return rl
  }

  createRL()

  while (true) {
    try {
      status.taskCount = (getDb().query("SELECT COUNT(*) as c FROM code_tasks WHERE status NOT IN ('cancelled','completed')").get() as any)?.c ?? 0
      status.tokenCount = (getDb().query("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as t FROM code_traces").get() as any)?.t ?? 0
    } catch {}

    if (!rl) rl = createRL()

    process.stdout.write(`\n${buildStatusBar(status)}\n`)
    const promptStr = ` ${BEE.waiting} ${C.white}\u00bfQu\u00e9 quieres construir?${C.reset} `

    const line = await new Promise<string | null>((resolve) => {
      if (!rl) { resolve(null); return }
      rl.once("line", resolve)
      rl.once("close", () => resolve(null))
      rl.setPrompt(promptStr)
      rl.prompt()
    })

    if (line === null) break

    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("/")) {
      const result = await handleCommand(trimmed, status)
      if (result === "exit") break
      continue
    }

    closeRL()
    try {
      await executeTask(trimmed, status)
    } catch (err) {
      logger.error("[repl] Task execution error:", err)
      process.stdout.write(` ${BEE.error} ${(err as Error).message}\n`)
    }
    createRL()
  }

  closeRL()
  process.stdin.removeListener("keypress", handleShiftTab)
  process.stdout.write(`\n  ${C.amber}${S.barEnd}${C.reset}  ${C.green}${S.check}${C.reset}  Hasta luego\n\n`)
}
