import * as path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { getHiveDir } from "@johpaz/hivecode-core/config/loader"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import {
  isCancel, hiveSelect, hiveNote, hiveOutro, hiveSpinner,
  runProviderSetupWizard,
} from "@johpaz/hivecode-ui"
import { loadInitialState, saveMode } from "./repl-state"
import type { ReplMode } from "./repl-state"
import { parseInternalCommand, getCtx, renderSuggestions } from "@johpaz/hivecode-code/coordinator/command-parser"
import type { MenuItem } from "@johpaz/hivecode-code/coordinator/command-parser"
import { plan as runPlan } from "./plan"
import { run as runTask } from "./run"
import { launchTui, tuiAvailable } from "./tui-launcher"

const VERSION = "1.0.0"

// ─── Gateway lifecycle ────────────────────────────────────────────────────────

let _gatewayChild: ChildProcess | null = null

function isGatewayRunning(): boolean {
  try {
    const pidFile = path.join(getHiveDir(), "gateway.pid")
    if (!existsSync(pidFile)) return false
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
    if (isNaN(pid)) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForGateway(port = 16120, timeout = 15000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
      if (r.ok) return true
    } catch { /* not ready yet */ }
    await Bun.sleep(300)
  }
  return false
}

async function ensureGateway(): Promise<void> {
  if (isGatewayRunning()) return

  const spinner = hiveSpinner("default")
  spinner.start("Iniciando Gateway...")

  _gatewayChild = spawn(
    process.execPath,
    [process.argv[1] || "", "start", "--skip-check"],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HIVE_GATEWAY_CHILD: "1" },
    }
  )

  const cleanup = () => {
    if (_gatewayChild?.pid) {
      try { process.kill(-_gatewayChild.pid, "SIGTERM") } catch { _gatewayChild?.kill("SIGTERM") }
    }
  }
  process.once("SIGINT",  () => { cleanup(); process.exit(0) })
  process.once("SIGTERM", () => { cleanup(); process.exit(0) })
  process.once("exit",    cleanup)

  const ready = await waitForGateway()
  if (!ready) {
    spinner.stop("Gateway no respondió a tiempo", "error")
    hiveOutro("Revisa con: hivecode doctor", "error")
    process.exit(1)
  }
  spinner.stop("Gateway listo")
}

// ─── TUI binary compile-on-demand ─────────────────────────────────────────────

async function ensureTuiBinary(): Promise<void> {
  if (tuiAvailable()) return
  const tuiDir = path.join(import.meta.dir, "../../../tui")
  if (!existsSync(tuiDir)) return
  const spinner = hiveSpinner("default")
  spinner.start("Compilando TUI binary (primera vez)...")
  const proc = Bun.spawnSync(["cargo", "build", "--release"], {
    cwd: tuiDir,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (proc.exitCode === 0) {
    spinner.stop("TUI binary compilado")
  } else {
    spinner.stop("No se pudo compilar el TUI binary — continuando sin TUI", "error")
  }
}

// ─── Provider guard ───────────────────────────────────────────────────────────

async function ensureProvider(
  provider: string,
): Promise<{ provider: string; model: string } | null> {
  if (provider) return null  // ya configurado, sin acción

  hiveNote("Sin provider configurado", [
    "Necesitas un provider LLM para ejecutar tareas.",
    "Configura uno ahora o usa: hivecode provider add",
  ])
  const choice = await hiveSelect({
    message: "¿Qué deseas hacer?",
    options: [
      { value: "setup", label: "Configurar provider ahora" },
      { value: "cancel", label: "Cancelar" },
    ],
  })
  if (isCancel(choice) || choice === "cancel") return null

  const db = getDb()
  const knownProviders = (
    db.query("SELECT id FROM providers ORDER BY id").all() as { id: string }[]
  ).map((r) => r.id)

  const result = await runProviderSetupWizard(knownProviders, VERSION)
  if (!result) return null

  // Upsert provider row without DELETE (INSERT OR REPLACE breaks FK refs from models table)
  db.query(`
    INSERT INTO providers (id, name, base_url, api_key_encrypted, enabled)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      base_url = excluded.base_url,
      api_key_encrypted = excluded.api_key_encrypted,
      enabled = 1
  `).run(
    result.provider,
    result.provider,
    result.baseUrl || null,
    Buffer.from(result.apiKey || "").toString("base64"),
  )

  db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_provider', ?)").run(result.provider)
  if (result.model) {
    db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)").run(
      `provider_model_${result.provider}`,
      result.model,
    )
  }

  // Update all coordinator agents to use this provider/model
  // Only set model_id if the model actually exists in models table (FK guard)
  const agentModelId = result.model
    ? (db.query("SELECT 1 FROM models WHERE id = ?").get(result.model) ? result.model : null)
    : null
  db.query(`
    UPDATE agents SET provider_id = ?, model_id = ?
    WHERE role = 'coordinator'
  `).run(result.provider, agentModelId)

  try {
    const secrets = (Bun as any).secrets
    if (secrets?.set)
      secrets.set(`${result.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`, result.apiKey)
  } catch { /* env secrets not available — key already stored in providers table */ }

  hiveOutro(`Provider ${result.provider} configurado`)
  return { provider: result.provider, model: result.model || "" }
}

// ─── Task execution ───────────────────────────────────────────────────────────

async function executeTask(
  task: string,
  mode: ReplMode,
  options?: { suspend?: () => Promise<void>; resume?: () => void },
): Promise<string> {
  // Captura todo lo que los coordinadores escriben a stdout
  const lines: string[] = []
  const origWrite = process.stdout.write.bind(process.stdout)
  ;(process.stdout as any).write = (chunk: any, ...args: any[]) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString())
    return origWrite(chunk, ...args)
  }

  try {
    if (mode === "plan") {
      await runPlan(task, { keyboard: false })
    } else if (mode === "auto") {
      await runTask(task, [], { keyboard: false })
    } else {
      // approval: plan → pedir confirmación → run
      await runPlan(task, { keyboard: false })

      let approval: "yes" | "no" = "no"
      if (options?.suspend && options?.resume) {
        await options.suspend()
        try {
          const result = await hiveSelect({
            message: "¿Deseas implementar este plan?",
            options: [
              { value: "yes", label: "Sí, implementar" },
              { value: "no",  label: "No, volver" },
            ],
          })
          approval = (!isCancel(result) && result === "yes") ? "yes" : "no"
        } finally {
          options.resume()
        }
      } else {
        const result = await hiveSelect({
          message: "¿Deseas implementar este plan?",
          options: [
            { value: "yes", label: "Sí, implementar" },
            { value: "no",  label: "No, volver" },
          ],
        })
        approval = (!isCancel(result) && result === "yes") ? "yes" : "no"
      }

      if (approval === "yes") {
        await runTask(task, [], { keyboard: false })
      }
    }
  } finally {
    ;(process.stdout as any).write = origWrite
  }

  // Devuelve un resumen limpio (sin ANSI) para el historial Rezi
  const raw = lines.join("")
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").trim()
  return clean.length > 1200 ? clean.slice(0, 1200) + "\n…(salida recortada)" : clean
}

// ─── Internal command handler ─────────────────────────────────────────────────

async function handleInternalCommand(
  input: string,
  currentMode: ReplMode,
  provider: string,
  model: string,
): Promise<{ output: string; newMode?: ReplMode; newProvider?: string; newModel?: string; quickMenu?: MenuItem[] }> {
  const db = getDb()
  const ctx = getCtx(db)

  const result = await parseInternalCommand(input, db, {
    ...ctx,
    activeMode: currentMode,
    activeProvider: provider,
    activeModel: model,
  })

  return {
    output:      result.output ?? "",
    newMode:     result.newState?.activeMode as ReplMode | undefined,
    newProvider: result.newState?.activeProvider,
    newModel:    result.newState?.activeModel,
    quickMenu:   result.menu,
  }
}

// ─── REPL entry point ─────────────────────────────────────────────────────────

export async function repl(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log("REPL requires a TTY. Use 'hivecode <command>' for non-interactive mode.")
    return
  }

  await ensureGateway()
  await ensureTuiBinary()

  const init = loadInitialState()

  // Provider guard al arranque
  if (!init.provider) {
    const configured = await ensureProvider("")
    if (configured) {
      init.provider = configured.provider
      init.model    = configured.model
    }
  }

  const agentCount = (getDb()
    .query("SELECT COUNT(*) as c FROM agents WHERE role='coordinator' AND enabled=1")
    .get() as any)?.c ?? 0

  // ── Ratatui TUI (preferred) ────────────────────────────────────────────────
  if (tuiAvailable()) {
    // Keep track of current state for IPC callbacks
    let currentMode:     ReplMode = init.mode
    let currentProvider: string   = init.provider
    let currentModel:    string   = init.model

    const tuiControl: { suspend: (() => Promise<void>) | null; resume: (() => void) | null } = {
      suspend: null,
      resume: null,
    }

    await launchTui({
      initialMode:     init.mode,
      initialProvider: init.provider,
      initialModel:    init.model,
      projectName:     path.basename(init.projectPath),
      projectPath:     init.projectPath,
      version:         VERSION,
      taskCount:       init.taskCount,
      tokenCount:      init.tokenCount,
      agentCount,

      getSuggestions: (query) => renderSuggestions(query),

      onModeChange(mode) {
        currentMode = mode as ReplMode
        saveMode(mode)
      },

      onExit() {
        logger.info("[repl] Sesión terminada")
      },

      tuiControl,

      async onSubmit(input) {
        if (input.startsWith("/")) {
          const result = await handleInternalCommand(
            input, currentMode, currentProvider, currentModel,
          )
          if (result.newMode)     currentMode     = result.newMode
          if (result.newProvider) currentProvider = result.newProvider
          if (result.newModel)    currentModel    = result.newModel
          return {
            output:      result.output,
            newMode:     result.newMode,
            newProvider: result.newProvider,
            newModel:    result.newModel,
          }
        }

        const guardResult = await ensureProvider(currentProvider)
        const provider = guardResult ? guardResult.provider : currentProvider
        const model    = guardResult ? guardResult.model    : currentModel
        if (guardResult) {
          currentProvider = provider
          currentModel    = model
        }

        if (!provider) {
          return { output: "(×ᴗ×) Sin provider — tarea cancelada." }
        }

        const output = await executeTask(input, currentMode, {
          suspend: tuiControl.suspend ?? undefined,
          resume: tuiControl.resume ?? undefined,
        })
        return {
          output,
          ...(guardResult && { newProvider: provider, newModel: model }),
        }
      },
    })
    return
  }

  hiveNote("TUI binary no encontrado", [
    "Compila el binario Ratatui con:",
    "  cd packages/tui && cargo build",
  ])
  hiveOutro("Ejecuta el comando anterior y vuelve a intentarlo", "error")
}
