import * as path from "node:path"
import fs, { existsSync, mkdirSync, readFileSync } from "node:fs"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { getHiveDir } from "@johpaz/hivecode-core/config/loader"
import { loadConfig, startGateway } from "@johpaz/hivecode-core/gateway"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import {
  isCancel, hiveSelect, hiveNote, hiveOutro, hiveSpinner,
  runProviderSetupWizard,
  runTelegramConnectWizard,
} from "@johpaz/hivecode-tui-primitives"
import { loadInitialState } from "./repl-state"
import type { ReplMode } from "./repl-state"
import { parseInternalCommand, getCtx, renderSuggestions } from "@johpaz/hivecode-code/coordinator/command-parser"
import type { MenuItem } from "@johpaz/hivecode-code/coordinator/command-parser"
import { plan as runPlan } from "./plan"
import { run as runTask } from "./run"
import { launchTui, tuiAvailable } from "./tui-launcher"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"

const VERSION = "1.0.0"

function isLikelyMarkdown(content: string): boolean {
  if (content.includes("```")) return true
  const lines = content.split("\n").slice(0, 5)
  for (const l of lines) {
    if (l.startsWith("# ") || l.startsWith("## ") || l.startsWith("### ")) return true
  }
  if (content.includes("**")) {
    const first = content.indexOf("**")
    const last = content.lastIndexOf("**")
    if (first !== -1 && last !== -1 && first !== last) return true
  }
  let bulletCount = 0
  for (const l of content.split("\n").slice(0, 10)) {
    if (l.startsWith("- ") || l.startsWith("* ")) bulletCount++
  }
  if (bulletCount >= 2) return true
  const backtickCount = (content.match(/`/g) || []).length
  if (backtickCount >= 2) return true
  return false
}

// ─── Gateway lifecycle ────────────────────────────────────────────────────────

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

async function waitForGateway(port = 16120, timeout = 10000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
      if (r.ok) return true
    } catch { /* not ready yet */ }
    await Bun.sleep(200)
  }
  return false
}

// Start gateway in the SAME process so ui-broadcast.ts module state is shared
// between tui-launcher.ts (which registers messageHandler) and server.ts
// (which handles /ui-ws WebSocket messages). Cross-process singletons don't work.
async function ensureGateway(): Promise<void> {
  if (isGatewayRunning()) return

  const spinner = hiveSpinner("default")
  spinner.start("Iniciando Gateway...")

  try {
    const config = await loadConfig()
    startGateway(config).catch((err) => {
      logger.error("[repl] Gateway error:", err.message)
    })
    const ready = await waitForGateway()
    if (!ready) {
      spinner.stop("Gateway no respondió a tiempo", "error")
      hiveOutro("Revisa con: hivecode doctor", "error")
      process.exit(1)
    }
    spinner.stop("Gateway listo")
  } catch (err) {
    spinner.stop("Error iniciando gateway: " + (err as Error).message, "error")
    process.exit(1)
  }
}

// ─── TUI binary compile-on-demand ─────────────────────────────────────────────
// En dev mode el script package.json ya corrió `cargo build` antes de arrancar,
// así que aquí solo compilamos si el binario no existe todavía.

async function ensureTuiBinary(): Promise<void> {
  const tuiDir = path.join(import.meta.dir, "../../../hivetui")
  if (!existsSync(tuiDir)) return
  if (tuiAvailable()) return

  const isDev = process.env.HIVE_DEV === "true"
  const args  = isDev ? ["cargo", "build"] : ["cargo", "build", "--release"]

  const spinner = hiveSpinner("default")
  spinner.start("Compilando hivetui (primera vez)...")
  const proc = Bun.spawnSync(args, {
    cwd: tuiDir,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (proc.exitCode === 0) {
    spinner.stop("hivetui compilado")
  } else {
    spinner.stop("hivetui build falló — continuando sin TUI", "error")
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
  options?: { suspend?: () => Promise<void>; resume?: () => void; manager?: CoordinatorManager; quiet?: boolean },
): Promise<string> {
  const quiet = options?.quiet ?? false
  const manager = options?.manager

  // In TUI mode (manager provided), collect the final response via the coordinator's
  // task-complete callback instead of capturing stdout. Stdout capture includes
  // plan text, hiveSelect prompts, and other noise that garbles the history entry.
  if (manager && quiet) {
    let finalResponse = ""
    manager.setTaskCompleteCallback((response) => { finalResponse = response })

    try {
      if (mode === "plan") {
        await runPlan(task, { keyboard: false, exitOnError: false, manager, quiet })
      } else if (mode === "auto") {
        await runTask(task, [], { keyboard: false, exitOnError: false, manager, quiet })
      } else {
        // approval: plan → mostrar al usuario → implementar si aprueba
        await runPlan(task, { keyboard: false, exitOnError: false, manager, quiet })

        // En modo TUI (quiet=true), la TUI muestra el plan y el usuario usa
        // /approve o /reject desde el input. No suspender el proceso porque
        // hivetui no implementa el protocolo suspend/resume → deadlock.
        // finalResponse ya tiene la respuesta del plan (seteada por onTaskComplete).
      }
    } finally {
      manager.setTaskCompleteCallback(undefined)
    }

    return finalResponse.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").trim()
  }

  // Non-TUI path: capture stdout (original behaviour)
  const lines: string[] = []
  const origWrite = process.stdout.write.bind(process.stdout)
  ;(process.stdout as any).write = (chunk: any, ...args: any[]) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString())
    return origWrite(chunk, ...args)
  }

  try {
    if (mode === "plan") {
      await runPlan(task, { keyboard: false, exitOnError: false, manager, quiet })
    } else if (mode === "auto") {
      await runTask(task, [], { keyboard: false, exitOnError: false, manager, quiet })
    } else {
      await runPlan(task, { keyboard: false, exitOnError: false, manager, quiet })

      const result = await hiveSelect({
        message: "¿Deseas implementar este plan?",
        options: [
          { value: "yes", label: "Sí, implementar" },
          { value: "no",  label: "No, volver" },
        ],
      })
      const approval = (!isCancel(result) && result === "yes") ? "yes" : "no"

      if (approval === "yes") {
        await runTask(task, [], { keyboard: false, exitOnError: false, manager, quiet })
      }
    }
  } finally {
    ;(process.stdout as any).write = origWrite
  }

  const raw = lines.join("")
  return raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").trim()
}

// ─── Internal command handler ─────────────────────────────────────────────────

async function handleInternalCommand(
  input: string,
  currentMode: ReplMode,
  provider: string,
  model: string,
  ui?: import("@johpaz/hivecode-code/coordinator/command-parser").UiCallbacks,
): Promise<{ output: string; newMode?: ReplMode; newProvider?: string; newModel?: string; quickMenu?: MenuItem[] }> {
  const db = getDb()
  const ctx = getCtx(db)

  const result = await parseInternalCommand(input, db, {
    ...ctx,
    activeMode: currentMode,
    activeProvider: provider,
    activeModel: model,
  }, ui)

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

  // Silence ALL logs (main thread + workers + gateway) before TUI takes over
  process.env.HIVE_LOG_CONSOLE = "false"
  logger.setConsole(false)

  await ensureGateway()
  await ensureTuiBinary()

  const init = loadInitialState()

  // Provider guard al arranque (antes de iniciar workers, para que tengan las claves)
  if (!init.provider) {
    const configured = await ensureProvider("")
    if (configured) {
      init.provider = configured.provider
      init.model    = configured.model
    }
  }

  // Start coordinator workers and open a session (one per TUI lifecycle)
  const manager = new CoordinatorManager()

  // Lazy IPC forwarder — populated once TUI socket is ready, null before that.
  // Events fired before TUI connects (should not happen in practice) are silently dropped.
  let _tuiIpcSend: ((msg: any) => void) | null = null
  manager.setIpcCallback((event, payload) => {
    if (!_tuiIpcSend) return
    if (event === "conflict_detected") {
      const p = payload as any
      _tuiIpcSend({
        type: "conflict_alert",
        agent_a: p.agent_a ?? "",
        agent_b: p.agent_b ?? "",
        file: p.file_path ?? "",
        reason: p.reason ?? p.description ?? "",
        severity: p.severity ?? "high",
        detail: p.detail ?? null,
      })
    } else {
      _tuiIpcSend({ type: event, ...(payload as object) })
    }
  })

  await manager.startAll()
  const sessionId = manager.openSession()
  logger.info(`[repl] Session started: ${sessionId}`)

  const activeWorkers: string[] = (getDb()
    .query("SELECT name FROM agents WHERE role='coordinator' AND enabled=1")
    .all() as any[]).map(r => r.name as string)

  // ── Ratatui TUI (preferred) ────────────────────────────────────────────────
  if (tuiAvailable()) {
    // Keep track of current state for IPC callbacks
    let currentMode:     ReplMode = init.mode
    let currentProvider: string   = init.provider
    let currentModel:    string   = init.model
    // When in plan mode, track the task awaiting user approval before execution
    let pendingPlanTask: string | null = null

    const tuiControl: {
      suspend: (() => Promise<void>) | null
      resume: (() => void) | null
      send: ((msg: import("./tui-launcher").BunMessage) => void) | null
      showConfigModal: ((cmd: string, title: string, fields: import("./tui-launcher").ModalField[]) => Promise<Record<string, string> | null>) | null
      showInfoModal: ((title: string, content: string) => Promise<void>) | null
    } = {
      suspend: null,
      resume: null,
      send: null,
      showConfigModal: null,
      showInfoModal: null,
    }

    // Wire live IPC events (file_risk_update, conflict_alert, etc.) to TUI socket
    _tuiIpcSend = (msg: any) => tuiControl.send?.(msg)

    // BEE-initiated mode changes (set_session_mode tool) propagate back to TUI
    manager.setModeChangeCallback((mode) => {
      currentMode = mode as ReplMode
      _tuiIpcSend?.({ type: "mode_change", mode })
    })

    // Forward narrative chunks from coordinators to TUI
    manager.setNarrativeCallback((chunk) => {
      const content = chunk.content
      const contentType = chunk.phase === "thinking"
        ? "thinking"
        : isLikelyMarkdown(content) ? "markdown" : "plain"
      tuiControl.send?.({
        type: "narrative_chunk",
        coordinator: chunk.coordinator,
        phase: chunk.phase,
        content,
        content_type: contentType,
        stream_id: (chunk as any).streamId,
      })
      // Also append non-thinking narratives to the main history feed so each agent appears as a separate message
      if (chunk.phase !== "thinking" && chunk.phase !== "reason" && content.trim().length > 2) {
        tuiControl.send?.({
          type: "history_append",
          role: "assistant",
          agent: chunk.coordinator,
          content,
          timestamp: new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }),
        })
      }
      // Send activity_update so the CODE tab workers panel shows live status
      const displayMap: Record<string, string> = {
        bee: "Bee",
        architecture: "Architecture",
        backend: "BackendEngineer",
        frontend: "FrontendEngineer",
        security: "SecurityAuditor",
        test: "QAEngineer",
        devops: "DevOpsEngineer",
        product_manager: "ProductManager",
        mobile: "MobileEngineer",
        data_scientist: "DataScientist",
        dba: "DBA",
        integration: "IntegrationEngineer",
        reviewer: "CodeReviewer",
      }
      tuiControl.send?.({
        type: "activity_update",
        coordinator: chunk.coordinator,
        phase: chunk.phase,
        status: chunk.phase === "thinking" || chunk.phase === "reason" ? "running" : "running",
        display_name: displayMap[chunk.coordinator] || chunk.coordinator,
        activity: content.slice(0, 80),
      })
    })

    // Forward tool worker status updates to TUI
    manager.setWorkerUpdateCallback((update) => {
      tuiControl.send?.({
        type: "activity_update",
        coordinator: `worker-${update.id}`,
        phase: update.tool || "idle",
        status: update.status === "busy" ? "running" : "idle",
        display_name: `Tool-${update.id}`,
        activity: update.tool ? `executing ${update.tool}` : "idle",
      })
    })


    // Redirect stdout/stderr to a log file so nothing breaks the TUI
    const tuiLogPath = path.join(getHiveDir(), "logs", "tui-session.log")
    try { mkdirSync(path.dirname(tuiLogPath), { recursive: true }) } catch { /* ignore */ }
    const tuiLogFd = fs.openSync(tuiLogPath, "a")
    const origStdoutWrite = process.stdout.write.bind(process.stdout)
    const origStderrWrite = process.stderr.write.bind(process.stderr)
    const origConsoleLog   = console.log
    const origConsoleWarn  = console.warn
    const origConsoleError = console.error
    const origConsoleInfo  = console.info
    const origConsoleDebug = console.debug
    const origConsoleTrace = console.trace
    const writeLog = (chunk: any) => {
      try {
        const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
        fs.writeSync(tuiLogFd, text)
      } catch {
        // Silently ignore write errors
      }
    }
    process.stdout.write = ((chunk: any, _encoding?: any, _callback?: any) => {
      writeLog(chunk)
      return true
    }) as any
    process.stderr.write = ((chunk: any, _encoding?: any, _callback?: any) => {
      writeLog(chunk)
      return true
    }) as any
    console.log   = (...args: any[]) => { writeLog(args.map(a => String(a)).join(" ") + "\n") }
    console.warn  = (...args: any[]) => { writeLog(args.map(a => String(a)).join(" ") + "\n") }
    console.error = (...args: any[]) => { writeLog(args.map(a => String(a)).join(" ") + "\n") }
    console.info  = (...args: any[]) => { writeLog(args.map(a => String(a)).join(" ") + "\n") }
    console.debug = (...args: any[]) => { writeLog(args.map(a => String(a)).join(" ") + "\n") }
    console.trace = (...args: any[]) => { writeLog(args.map(a => String(a)).join(" ") + "\n") }

    await launchTui({
      initialMode:     init.mode,
      initialProvider: init.provider,
      initialModel:    init.model,
      projectName:     path.basename(init.projectPath),
      projectPath:     init.projectPath,
      sessionId,
      version:         VERSION,
      taskCount:       init.taskCount,
      tokenCount:      init.tokenCount,
      workers:         activeWorkers,

      getSuggestions: (query) => renderSuggestions(query),

      onModeChange(mode) {
        currentMode = mode as ReplMode
      },

      onExit() {
        _tuiIpcSend = null
        // Close session and stop workers
        manager.closeSession()
        manager.stopAll().catch(() => {})
        // Restore stdout/stderr and console
        process.stdout.write = origStdoutWrite
        process.stderr.write = origStderrWrite
        console.log   = origConsoleLog
        console.warn  = origConsoleWarn
        console.error = origConsoleError
        console.info  = origConsoleInfo
        console.debug = origConsoleDebug
        console.trace = origConsoleTrace
        try { fs.closeSync(tuiLogFd) } catch { /* ignore */ }
        logger.setConsole(true)
        logger.info("[repl] Sesión terminada")
      },

      tuiControl,

      async onSubmit(input) {
        // ── Plan approval gate ─────────────────────────────────────────────
        if (pendingPlanTask) {
          const originalTask = pendingPlanTask
          const trimmed = input.trim().toLowerCase()

          // Reject
          if (trimmed === "n" || trimmed === "no" || trimmed.startsWith("/reject")) {
            pendingPlanTask = null
            return { output: "Plan cancelado. Puedes enviar una nueva tarea cuando quieras." }
          }

          // "Agregar contexto" option — keep pendingPlanTask so next submit gets the context
          // (the modal closed and user will type context and hit Enter again)
          if (!trimmed) {
            // plain Enter = auto approve (same as /approve auto)
          } else if (/^\/approve\s+review/.test(trimmed)) {
            // Approval mode — phase-by-phase
            pendingPlanTask = null
            const guardResult = await ensureProvider(currentProvider)
            const provider = guardResult ? guardResult.provider : currentProvider
            const model    = guardResult ? guardResult.model    : currentModel
            if (guardResult) { currentProvider = provider; currentModel = model; manager.reloadSecrets() }
            if (!provider) return { output: "(×ᴗ×) Sin provider — ejecución cancelada." }
            const out = await executeTask(originalTask, "approval", {
              suspend: tuiControl.suspend ?? undefined, resume: tuiControl.resume ?? undefined, manager, quiet: true,
            })
            return { output: out, ...(guardResult && { newProvider: provider, newModel: model }) }
          }

          // Auto approve (default, /approve auto, or any context text)
          pendingPlanTask = null
          const isPlainApprove = /^(y|si|sí|ok|yes|\/approve)/.test(trimmed) || !trimmed
          const taskWithContext = isPlainApprove
            ? originalTask
            : `${originalTask}\n\nContexto adicional del usuario: ${input}`

          const guardResult = await ensureProvider(currentProvider)
          const provider = guardResult ? guardResult.provider : currentProvider
          const model    = guardResult ? guardResult.model    : currentModel
          if (guardResult) { currentProvider = provider; currentModel = model; manager.reloadSecrets() }
          if (!provider) return { output: "(×ᴗ×) Sin provider — ejecución cancelada." }
          const output = await executeTask(taskWithContext, "auto", {
            suspend: tuiControl.suspend ?? undefined, resume: tuiControl.resume ?? undefined, manager, quiet: true,
          })
          return { output, ...(guardResult && { newProvider: provider, newModel: model }) }
        }

        if (input.startsWith("/")) {
          const result = await handleInternalCommand(
            input, currentMode, currentProvider, currentModel,
            {
              suspendTui:  async () => { await tuiControl.suspend!() },
              resumeTui:   () => { tuiControl.resume!() },
              runProviderSetupWizard,
              runTelegramConnectWizard,
              showConfigModal: tuiControl.showConfigModal ?? undefined,
              showInfoModal: tuiControl.showInfoModal ?? undefined,
              executeTask: async (task: string, mode: string) => {
                return executeTask(task, mode as ReplMode, {
                  suspend: tuiControl.suspend ?? undefined,
                  resume: tuiControl.resume ?? undefined,
                  manager,
                  quiet: true,
                })
              },
            },
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
          // Recargar secrets en el manager para que los workers las reciban en la próxima tarea
          manager.reloadSecrets()
        }

        if (!provider) {
          return { output: "(×ᴗ×) Sin provider — tarea cancelada." }
        }

        const output = await executeTask(input, currentMode, {
          suspend: tuiControl.suspend ?? undefined,
          resume: tuiControl.resume ?? undefined,
          manager,
          quiet: true,
        })

        // After a plan, show approval modal and wait for user decision
        if (currentMode === "plan") {
          pendingPlanTask = input
          _tuiIpcSend?.({ type: "plan_approval_request" })
        }

        return {
          output,
          ...(guardResult && { newProvider: provider, newModel: model }),
        }
      },
    })
    return
  }

  hiveNote("TUI binary no encontrado", [
    "Compila hivetui con:",
    "  cd packages/hivetui && cargo build",
  ])
  hiveOutro("Ejecuta el comando anterior y vuelve a intentarlo", "error")
}
