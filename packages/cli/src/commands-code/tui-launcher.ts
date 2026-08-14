/**
 * Launch the Rust/crossterm TUI binary and handle IPC with the Bun process.
 *
 * Architecture:
 *   Bun (this file) ←→ local IPC (Unix socket or Windows loopback TCP) ←→ hivecode-tui (Rust)
 *   Rust owns stdin/stdout (TTY), Bun owns business logic.
 */

import * as path from "node:path"
import * as fs from "node:fs"
import { extractHivetui, cachedHivetuiPath } from "../embedded-hivetui"
import { logger, onLogEntry, removeLogListener, type LogEntry } from "@johpaz/hivecode-core/utils/logger"
import { createIpcServer } from "@johpaz/hivecode-core/ipc/server"
import type { BunMessage as CoreBunMessage, TuiMessage as CoreTuiMessage } from "@johpaz/hivecode-core/ipc/protocol"
import { broadcastUiMessage, registerUiMessageHandler } from "@johpaz/hivecode-core/ipc/ui-broadcast"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type {
  AdrDoc,
  AgentDoc,
  AgentConflictDoc,
  AgentContextDoc,
  ChannelDoc,
  CheckpointDoc,
  CheckpointFileDoc,
  CodeConfigDoc,
  CodeDecisionDoc,
  CodeFileChangeDoc,
  CodeNarrativeDoc,
  CodeTaskDoc,
  CodeTaskPhaseDoc,
  CodeTurnDoc,
  FileRiskDoc,
  McpServerDoc,
  MessageDoc,
  ModelDoc,
  ProviderDoc,
  SessionDoc,
  SkillDoc,
  WorkerActivityDoc,
} from "@johpaz/hivecode-core/storage/collections"
import { restoreFiles } from "@johpaz/hivecode-code/checkpoint/rollback"

const SUPPORTED_LLM_PROVIDERS = new Set([
  "hiveagents",
  "openai",
  "anthropic",
  "gemini",
  "mistral",
  "deepseek",
  "kimi",
  "openrouter",
  "groq",
  "qwen",
  "nvidia",
  "codex",
  "opencode-go",
  "minimax",
  "hivecode-free",
])

function isLikelyMarkdown(content: string): boolean {
  if (content.includes("```")) return true
  for (const l of content.split("\n").slice(0, 5)) {
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

// ── Locate the binary ─────────────────────────────────────────────────────────

export function tuiBinPath(): string {
  const executableSuffix = process.platform === "win32" ? ".exe" : ""
  const debugBinary = path.join(
    import.meta.dir,
    `../../../hivetui/target/debug/hivetui${executableSuffix}`,
  )
  const releaseBinary = path.join(
    import.meta.dir,
    `../../../hivetui/target/release/hivetui${executableSuffix}`,
  )

  // `bun run dev` builds target/debug. Never let a freshly extracted but stale
  // embedded release binary win only because its cache mtime is newer.
  if (process.env.HIVE_DEV === "true" || process.env.HIVE_DEV === "1") {
    if (fs.existsSync(debugBinary)) return debugBinary
    if (fs.existsSync(releaseBinary)) return releaseBinary
  }

  const candidates = [
    // Extracted from embedded binary (compiled single-binary mode)
    cachedHivetuiPath(),
    // Running from dist/ bundle — binary sits next to hivecode
    path.join(path.dirname(process.argv[1] || ""), `hivetui${executableSuffix}`),
    path.join(path.dirname(process.argv[1] || ""), `hivecode-tui${executableSuffix}`),
    // Dev mode
    releaseBinary,
    debugBinary,
  ]

  const existing = candidates.filter(p => fs.existsSync(p))
  if (existing.length === 0) return ""

  return existing.reduce((best, cur) =>
    fs.statSync(cur).mtimeMs > fs.statSync(best).mtimeMs ? cur : best
  )
}

export function tuiAvailable(): boolean {
  return tuiBinPath() !== ""
}

// ── IPC message types ─────────────────────────────────────────────────────────

export interface ModalField {
  key: string
  label: string
  placeholder: string
  required: boolean
  secret: boolean
  field_type: "text" | "select"
  options?: string[]
  default_value?: string
}

export type BunMessage = CoreBunMessage

type TuiMessage = CoreTuiMessage

// ── Callbacks interface ───────────────────────────────────────────────────────

export interface TuiCallbacks {
  initialMode:      string
  initialProvider:  string
  initialModel:     string
  projectName:      string
  projectPath:      string
  sessionId:        string
  version:          string
  taskCount:        number
  tokenCount:       number
  workers:          string[]
  onSubmit:   (input: string) => Promise<{ output: string; newMode?: string; newProvider?: string; newModel?: string; newTokenCount?: number }>
  onModeChange?:  (mode: string) => void
  onExit?:        () => void
  /** Mutable ref populated by launchTui so callers can suspend/resume/send/showModal */
  tuiControl?:    {
    suspend: (() => Promise<void>) | null
    resume: (() => void) | null
    send: ((msg: BunMessage) => void) | null
    showConfigModal: ((command: string, title: string, fields: ModalField[]) => Promise<Record<string, string> | null>) | null
    showInfoModal: ((title: string, content: string) => Promise<void>) | null
  }
}

// ── Main launcher ─────────────────────────────────────────────────────────────

export async function launchTui(callbacks: TuiCallbacks): Promise<void> {
  const binPath = tuiBinPath()
  if (!binPath) {
    throw new Error(
      "hivetui binary not found.\n" +
      "Build it with:  cd packages/hivetui && cargo build",
    )
  }

  const socketPath = process.platform === "win32" ? undefined : `/tmp/hivecode-${process.pid}.sock`

  // Clean up any leftover socket
  if (socketPath) {
    try { fs.unlinkSync(socketPath) } catch { /* ignore */ }
  }

  return new Promise((resolve, reject) => {
    // Resolves when Rust confirms it has released the TTY
    let suspendedResolve: (() => void) | null = null
    let modalResolve: ((values: Record<string, string> | null) => void) | null = null
    let infoModalResolve: (() => void) | null = null
    let tuiSocket: import("bun").Socket<undefined> | null = null
    let buf = ""

    let ipcServer: ReturnType<typeof createIpcServer> | null = null
    const send = (msg: BunMessage) => {
      ipcServer?.send(msg)
      broadcastUiMessage(msg)
    }

    // Subscribe to real-time logs and forward to TUI
    const logCb = (entry: LogEntry) => {
      send({
        type: "log_entry",
        timestamp: entry.timestamp,
        level: entry.level,
        source: entry.source,
        message: entry.message,
      })
    }
    onLogEntry(logCb)

    const suspendTui = (): Promise<void> =>
      new Promise((res) => { suspendedResolve = res; send({ type: "suspend" }) })

    const resumeTui = () => send({ type: "resume" })

    const showConfigModal = (command: string, title: string, fields: ModalField[]): Promise<Record<string, string> | null> => {
      console.error(`[tui-ipc] showConfigModal: ${command} - ${title}`)
      send({ type: "show_config_modal", command, title, fields })
      return new Promise((res) => { modalResolve = res })
    }

    const showInfoModal = (title: string, content: string): Promise<void> => {
      console.error(`[tui-ipc] showInfoModal: ${title}`)
      send({ type: "show_info_modal", title, content })
      return new Promise((res) => { infoModalResolve = res })
    }

    if (callbacks.tuiControl) {
      callbacks.tuiControl.suspend = suspendTui
      callbacks.tuiControl.resume = resumeTui
      callbacks.tuiControl.send = send
      callbacks.tuiControl.showConfigModal = showConfigModal
      callbacks.tuiControl.showInfoModal = showInfoModal
    }

    // ── Bridge: React UI WebSocket → same handler as Rust TUI ────────────────
    registerUiMessageHandler((msg) => {
      handleTuiMessage(msg, send, callbacks).catch((err) => {
        logger.error("[ui-ws] handler error", err)
        send({ type: "history_append", role: "system", content: `(×ᴗ×) ${(err as Error).message}` })
        send({ type: "status", running: false, msg: "Error" })
      })
    })

    // ── IPC server (Unix socket on Unix, loopback TCP on Windows) ───────────
    try {
      ipcServer = createIpcServer({
        socketPath,
        tcp: process.platform === "win32" ? { hostname: "127.0.0.1" } : undefined,
        sessionId: callbacks.sessionId,
        onMessage(msg) {
          if (msg.type === "suspended") {
            suspendedResolve?.()
            suspendedResolve = null
            return
          }
          if (msg.type === "modal_submit") {
            modalResolve?.(msg.values)
            modalResolve = null
            return
          }
          if (msg.type === "modal_cancel") {
            modalResolve?.(null)
            modalResolve = null
            return
          }
          if (msg.type === "info_modal_close") {
            infoModalResolve?.()
            infoModalResolve = null
            return
          }
          if (msg.type === "request_settings") {
            void sendSettingsSnapshot(send)
            return
          }
          handleTuiMessage(msg, send, callbacks).catch((err) => {
            logger.error("[tui-ipc] handler error", err)
            send({ type: "history_append", role: "system", content: `(×ᴗ×) ${(err as Error).message}` })
            send({ type: "status", running: false, msg: "Error" })
          })
        },
        onError(err) {
          logger.warn("[tui-ipc] socket error:", err.message)
        },
      })
    } catch (err) {
      reject(err)
      return
    }

    // ── Launch TUI binary (Bun.listen is synchronous — socket ready now) ───
    process.stderr.write(`[tui] launching: ${binPath}\n`)
    process.stderr.write(`[tui] IPC: ${ipcServer.endpoint}\n`)
    const proc = Bun.spawn([binPath], {
      stdin:  0,
      stdout: 1,
      stderr: 2,
      env:    { ...process.env, HIVECODE_IPC: ipcServer.endpoint },
    })
    process.stderr.write(`[tui] PID: ${proc.pid}\n`)

    proc.exited.then((code) => {
      process.stderr.write(`[tui] hivetui exited with code: ${code}\n`)
      removeLogListener(logCb)
      callbacks.onExit?.()
      ipcServer?.stop()
      ipcServer = null
      if (socketPath) {
        try { fs.unlinkSync(socketPath) } catch { /* ignore */ }
      }
      resolve()
    }).catch(reject)
  })
}

// ── Message router ────────────────────────────────────────────────────────────

async function handleTuiMessage(
  msg: TuiMessage,
  send: (m: BunMessage) => void,
  callbacks: TuiCallbacks,
): Promise<void> {
  switch (msg.type) {
    case "ready":
      send({
        type:          "init",
        mode:          callbacks.initialMode,
        provider:      callbacks.initialProvider,
        model:         callbacks.initialModel,
        project_name:  callbacks.projectName,
        project_path:  callbacks.projectPath,
        session_id:    callbacks.sessionId,
        version:       callbacks.version,
        task_count:    callbacks.taskCount,
        token_count:   callbacks.tokenCount,
        workers:       callbacks.workers,
      })
      // Dump session state so TUI can rebuild on startup
      try {
        await sendHistorySnapshot(send, callbacks.sessionId)

        // Checkpoint timeline (last 20, sent oldest-first)
        const cps = await loadCheckpoints(callbacks.sessionId)
        for (const cp of cps) {
          send({ type: "checkpoint_created", checkpoint_id: cp.id,
                 description: cp.description, file_count: cp.file_count,
                 agent: cp.created_by ?? "system" })
        }

        await sendFileSnapshots(send, callbacks.sessionId)
        await sendAdrSnapshot(send)
        await sendCodeTaskSnapshot(send, callbacks.sessionId)

        await sendDashboardSnapshot(send, callbacks.sessionId, cps)
      } catch (e) {
        logger.warn("[tui-ipc] init snapshot failed:", (e as Error).message)
      }
      send({ type: "status", running: false, msg: "Listo · escribe tu tarea" })
      break


    case "submit": {
      const input = msg.input
      try {
        const agentConfigMatch = /^\/agent\s+configure\s+(\S+)$/i.exec(input.trim())
        if (agentConfigMatch) {
          const agentsCol = await col<AgentDoc>("agents")
          const row = await agentsCol.get(agentConfigMatch[1].toLowerCase())
          if (!row?.doc.agent_type) throw new Error(`Perfil core no encontrado: ${agentConfigMatch[1]}`)
          const profile = row.doc
          const field = (key: string, label: string, placeholder: string): ModalField => ({
            key, label, placeholder, required: false, secret: false, field_type: "text",
          })
          const values = await callbacks.tuiControl?.showConfigModal?.(
            `agent-config:${profile.id}`,
            `Configurar ${profile.name}`,
            [
              field("provider", "Provider", String(profile.provider_id ?? "")),
              field("model", "Modelo", String(profile.model_id ?? "")),
              field("fallback_provider", "Provider fallback", String(profile.fallback_provider_id ?? "")),
              field("fallback_model", "Modelo fallback", String(profile.fallback_model_id ?? "")),
              field("effort", "Effort", profile.effort ?? "medium"),
              field("max_turns", "Máx. turnos", String(profile.max_iterations)),
              field("max_input_tokens", "Máx. tokens entrada", String(profile.max_input_tokens ?? 0)),
              field("max_output_tokens", "Máx. tokens salida", String(profile.max_output_tokens ?? 0)),
              field("max_cost_usd", "Costo máximo USD", String(profile.max_cost_usd ?? 0)),
              field("user_instructions", "Instrucciones adicionales", profile.user_instructions ?? ""),
            ],
          )
          if (values) {
            await agentsCol.put(profile.id, {
              ...profile,
              provider_id: values.provider || profile.provider_id,
              model_id: values.model || profile.model_id,
              fallback_provider_id: values.fallback_provider || profile.fallback_provider_id,
              fallback_model_id: values.fallback_model || profile.fallback_model_id,
              effort: (["low", "medium", "high", "xhigh", "max"].includes(values.effort)
                ? values.effort
                : profile.effort) as AgentDoc["effort"],
              max_iterations: Number(values.max_turns || profile.max_iterations),
              max_input_tokens: Number(values.max_input_tokens || 0),
              max_output_tokens: Number(values.max_output_tokens || 0),
              max_cost_usd: Number(values.max_cost_usd || 0),
              user_instructions: values.user_instructions ?? profile.user_instructions,
              config_version: (profile.config_version ?? 0) + 1,
              updated_at: Date.now(),
            }, { expectedVersion: row.version })
            send({ type: "history_append", role: "system", content: `Configuración de ${profile.name} actualizada.` })
            await sendSettingsSnapshot(send)
          }
          send({ type: "status", running: false, msg: "Listo" })
          break
        }
        send({ type: "activity_update", coordinator: "agent", phase: input, status: "thinking" })
        const result = await callbacks.onSubmit(input)
        if (result.output) {
          send({ type: "history_append", role: "assistant", content: result.output, content_type: isLikelyMarkdown(result.output) ? "markdown" : "plain", agent: "bee", timestamp: new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }) })
        }
        send({ type: "status",         running: false,    msg: "Listo · [shift+tab] cambiar modo" })
        send({ type: "activity_update", coordinator: "", phase: "", status: "idle" })
        if (result.newMode || result.newProvider || result.newModel || result.newTokenCount !== undefined) {
          send({
            type:         "state_update",
            new_mode:     result.newMode,
            new_provider: result.newProvider,
            new_model:    result.newModel,
            new_token_count: result.newTokenCount,
          })
        }
        if (input.startsWith("/telegram")) {
          await sendSettingsSnapshot(send)
        }
      } catch (err) {
        send({
          type:    "history_append",
          role:    "system",
          content: `(×ᴗ×) ${(err as Error).message}`,
        })
        send({ type: "status", running: false, msg: "Error" })
        send({ type: "activity_update", coordinator: "", phase: "", status: "idle" })
      }
      break
    }

    case "mode_change":
      callbacks.onModeChange?.(msg.mode)
      break

    case "exit":
      break

    case "rollback": {
      const checkpointId = (msg as { type: string; checkpoint_id?: string }).checkpoint_id
      if (!checkpointId) {
        send({ type: "history_append", role: "system", content: "↩ Rollback sin checkpoint_id" })
        break
      }
      try {
        const checkpointFiles = await col<CheckpointFileDoc>("checkpointFiles")
        const files = (await checkpointFiles.findBy("checkpoint_id", checkpointId)).map((entry, index) => ({
          id: index,
          checkpoint_id: entry.doc.checkpoint_id,
          file_path: entry.doc.file_path,
          content: Buffer.from(entry.doc.content, "base64"),
          content_hash: entry.doc.content_hash,
          operation: entry.doc.operation,
        }))
        const restored = await restoreFiles(files)
        const checkpoints = await col<CheckpointDoc>("checkpoints")
        const checkpoint = await checkpoints.get(checkpointId)
        if (checkpoint) {
          await checkpoints.put(checkpointId, { ...checkpoint.doc, restored_at: Date.now() }, { expectedVersion: checkpoint.version })
        }
        send({ type: "checkpoint_rollback", checkpoint_id: checkpointId, files_restored: restored.length })
        send({ type: "blackboard_event", timestamp: currentTime(), agent: "bee", event_type: "RESOLVED", content: `rollback ${checkpointId}: ${restored.length} archivo(s)` })
      } catch (err) {
        send({ type: "history_append", role: "system", content: `(×ᴗ×) rollback falló: ${(err as Error).message}` })
        send({ type: "status", running: false, msg: "Rollback falló" })
      }
      break
    }
  }
}

function currentTime(): string {
  return new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function hhmmss(value: number): string {
  return new Date(value).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function ms(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function timeFrom(value: number | string | null | undefined): string {
  const timestamp = ms(value)
  return hhmmss(timestamp || Date.now())
}

function phaseStatusForTui(status: string): string {
  if (status === "completed") return "done"
  if (status === "skipped") return "done"
  if (status === "pending") return "waiting"
  return status
}

function displayNameForAgent(name: string): string {
  const names: Record<string, string> = {
    bee: "Bee",
    product_manager: "ProductManager",
    architecture: "Architecture",
    architect: "Architecture",
    backend: "BackendEngineer",
    frontend: "FrontendEngineer",
    data_scientist: "DataScientist",
    security: "SecurityAuditor",
    test: "QAEngineer",
    devops: "DevOpsEngineer",
    verifier: "Verifier",
    reviewer: "CodeReviewer",
    librarian: "Librarian",
  }
  return names[name] ?? name
}

async function scanDocs<T>(collection: string): Promise<T[]> {
  try {
    return (await (await col<T>(collection)).scan()).map((entry) => entry.doc)
  } catch {
    return []
  }
}

async function findDocsBy<T>(
  collection: string,
  field: string,
  value: string | number | boolean,
): Promise<T[]> {
  try {
    return (await (await col<T>(collection)).findBy(field, value)).map((entry) => entry.doc)
  } catch {
    return (await scanDocs<T>(collection)).filter((doc) => (doc as Record<string, unknown>)[field] === value)
  }
}

function latestBy<T>(rows: T[], keyOf: (row: T) => string, timeOf: (row: T) => number): T[] {
  const seen = new Map<string, T>()
  for (const row of rows.sort((a, b) => timeOf(b) - timeOf(a))) {
    const key = keyOf(row)
    if (!seen.has(key)) seen.set(key, row)
  }
  return [...seen.values()]
}

async function sendHistorySnapshot(send: (m: BunMessage) => void, sessionId: string): Promise<void> {
  const turns = (await findDocsBy<CodeTurnDoc>("codeTurns", "session_id", sessionId))
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))
    .slice(0, 25)
    .reverse()

  if (turns.length > 0) {
    for (const turn of turns) {
      send({
        type: "history_append",
        role: "user",
        content: turn.user_message,
        content_type: "plain",
        timestamp: timeFrom(turn.created_at),
        task_id: turn.task_id ?? undefined,
      })
      if (turn.agent_response.trim()) {
        send({
          type: "history_append",
          role: "assistant",
          content: turn.agent_response,
          content_type: isLikelyMarkdown(turn.agent_response) ? "markdown" : "plain",
          agent: "bee",
          timestamp: timeFrom(turn.completed_at ?? turn.created_at),
          task_id: turn.task_id ?? undefined,
        })
      }
    }
    return
  }

  const msgs = (await findDocsBy<MessageDoc>("messages", "session_id", sessionId))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50)
    .reverse()
  for (const m of msgs) {
    send({
      type: "history_append",
      role: m.role,
      content: m.content,
      content_type: m.content_type === "diff" ? "plain" : m.content_type,
      agent: m.agent ?? undefined,
      timestamp: hhmmss(m.created_at),
    })
  }
}

async function loadCheckpoints(sessionId: string): Promise<CheckpointDoc[]> {
  return (await findDocsBy<CheckpointDoc>("checkpoints", "session_id", sessionId))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 20)
    .reverse()
}

async function sendFileSnapshots(send: (m: BunMessage) => void, sessionId: string): Promise<void> {
  const risks = await findDocsBy<FileRiskDoc>("fileRisks", "session_id", sessionId)
  for (const r of risks) {
    send({
      type: "file_risk_update",
      path: r.file_path,
      risk: r.risk_level,
      operation: r.operation ?? "modified",
      adr_ref: r.adr_ref,
      reason: r.reason ?? "",
      agent: r.agent ?? "system",
    })
  }

  if (risks.length > 0) {
    send({
      type: "files_snapshot",
      files: latestBy(risks, (r) => r.file_path, (r) => r.updated_at).map((r) => ({
        path: r.file_path,
        risk: r.risk_level,
        operation: r.operation ?? "modified",
        agent: r.agent ?? "system",
      })),
    })
    return
  }

  const taskIds = new Set((await findDocsBy<CodeTaskDoc>("codeTasks", "session_id", sessionId)).map((task) => task.id))
  if (taskIds.size === 0) return
  const changes = (await scanDocs<CodeFileChangeDoc>("codeFileChanges"))
    .filter((change) => taskIds.has(change.task_id))
  if (changes.length === 0) return

  send({
    type: "files_snapshot",
    files: latestBy(changes, (change) => change.file_path, (change) => ms(change.created_at)).map((change) => ({
      path: change.file_path,
      risk: change.lines_removed > 40 || change.lines_added > 120 ? "medium" : "low",
      operation: change.change_type,
      agent: "bee",
    })),
  })
}

async function sendAdrSnapshot(send: (m: BunMessage) => void): Promise<void> {
  const adrs = (await scanDocs<AdrDoc>("adrs"))
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 10)
  for (const adr of adrs) {
    send({
      type: "adr_update",
      path: adr.file_path,
      title: adr.title,
      content: adr.content,
      status: adr.status ?? "accepted",
    })
  }
}

async function sendCodeTaskSnapshot(send: (m: BunMessage) => void, sessionId: string): Promise<CodeTaskDoc[]> {
  const tasks = (await findDocsBy<CodeTaskDoc>("codeTasks", "session_id", sessionId))
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))
    .slice(0, 10)
  if (tasks.length === 0) return []

  const taskIds = new Set(tasks.map((task) => task.id))
  const phases = (await scanDocs<CodeTaskPhaseDoc>("codeTaskPhases"))
    .filter((phase) => taskIds.has(phase.task_id))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  for (const task of [...tasks].reverse()) {
    const taskPhases = phases.filter((phase) => phase.task_id === task.id)
    const activeWorkers = taskPhases
      .filter((phase) => phase.status === "running")
      .map((phase) => phase.coordinator)

    send({
      type: "task_update",
      task_id: task.id,
      title: task.description,
      status: task.status,
      mode: task.mode ?? undefined,
      active_workers: activeWorkers.length > 0 ? [...new Set(activeWorkers)] : undefined,
      branch_name: task.branch_name ?? undefined,
    })
  }

  const activeTask = tasks.find((task) => !["completed", "failed", "cancelled", "rolled_back"].includes(task.status))
  if (activeTask) {
    await sendPlanSnapshot(send, activeTask, phases.filter((phase) => phase.task_id === activeTask.id))
  }

  return tasks
}

async function sendPlanSnapshot(
  send: (m: BunMessage) => void,
  task: CodeTaskDoc,
  phases: CodeTaskPhaseDoc[],
): Promise<void> {
  if (phases.length === 0) return

  const decision = (await findDocsBy<CodeDecisionDoc>("codeDecisions", "task_id", task.id))
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0]
  const adrContent = decision
    ? [decision.context, decision.options, decision.decision, decision.consequences].filter(Boolean).join("\n\n")
    : task.description

  send({
    type: "plan_update",
    task_id: task.id,
    adr_title: decision?.title ?? task.description,
    adr_content: adrContent,
    status: task.status === "paused" ? "approval" : task.status,
    phases: phases.map((phase) => ({
      name: phase.phase_name,
      coordinator: phase.coordinator,
      description: phase.result_summary ?? phase.phase_name,
      depends_on: [],
      level: fallbackWorkerLevel(phase.coordinator),
      status: phaseStatusForTui(phase.status),
    })),
    risks: [],
  })
}

async function sendDashboardSnapshot(
  send: (m: BunMessage) => void,
  sessionId: string,
  checkpoints: Array<{ id: string; description: string; file_count: number; created_by?: string; created_at: number }>,
): Promise<void> {
  const workers: any[] = []
  try {
    const workerActivity = await col<WorkerActivityDoc>("workerActivity")
    const rows = (await workerActivity.findBy("session_id", sessionId))
      .map((entry) => entry.doc)
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, 100)
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.worker)) continue
      seen.add(row.worker)
      workers.push({
        name: row.worker,
        status: row.status ?? "waiting",
        detail: row.phase ?? "",
        display_name: displayNameForAgent(row.worker),
        activity: row.current_action ?? row.phase ?? "",
        current_action: row.current_action ?? row.phase ?? "",
        level: Number(row.level ?? 0),
        token_count: Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0),
      })
    }
  } catch { /* session may predate worker activity */ }

  if (workers.length === 0) {
    try {
      const tasks = (await findDocsBy<CodeTaskDoc>("codeTasks", "session_id", sessionId))
        .sort((a, b) => ms(b.created_at) - ms(a.created_at))
      const taskIds = new Set(tasks.slice(0, 5).map((task) => task.id))
      const rows = (await scanDocs<CodeTaskPhaseDoc>("codeTaskPhases"))
        .filter((phase) => taskIds.has(phase.task_id))
        .sort((a, b) => ms(b.started_at ?? b.completed_at) - ms(a.started_at ?? a.completed_at))
      for (const row of latestBy(rows, (phase) => phase.coordinator, (phase) => ms(phase.started_at ?? phase.completed_at))) {
        workers.push({
          name: row.coordinator,
          status: phaseStatusForTui(row.status),
          detail: row.phase_name,
          display_name: displayNameForAgent(row.coordinator),
          activity: row.result_summary ?? row.phase_name,
          current_action: row.result_summary ?? row.phase_name,
          level: fallbackWorkerLevel(row.coordinator),
          token_count: Number(row.tokens_in ?? 0) + Number(row.tokens_out ?? 0),
        })
      }
    } catch { /* code task phase snapshot unavailable */ }
  }

  const blackboard_events: any[] = []
  try {
    const agentContext = await col<AgentContextDoc>("agentContext")
    const rows = (await agentContext.findBy("session_id", sessionId))
      .map((entry) => entry.doc)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 60)
    for (const row of rows.reverse()) {
      blackboard_events.push({
        timestamp: hhmmss(Number(row.created_at ?? Date.now())),
        agent: row.agent ?? "agent",
        event_type: String(row.type ?? "observation").toUpperCase(),
        content: row.content ?? "",
      })
    }
  } catch { /* agent context may be absent in fresh stores */ }

  if (blackboard_events.length === 0) {
    try {
      const rows = (await findDocsBy<CodeNarrativeDoc>("codeNarrative", "session_id", sessionId))
        .sort((a, b) => ms(b.created_at) - ms(a.created_at))
        .slice(0, 60)
      for (const row of rows.reverse()) {
        blackboard_events.push({
          timestamp: timeFrom(row.created_at),
          agent: row.coordinator ?? "agent",
          event_type: String(row.phase ?? "narrative").toUpperCase(),
          content: row.entry ?? "",
        })
      }
    } catch { /* narrative snapshot unavailable */ }
  }

  const conflicts: any[] = []
  try {
    const agentConflicts = await col<AgentConflictDoc>("agentConflicts")
    const rows = (await agentConflicts.findBy("session_id", sessionId))
      .map((entry) => entry.doc)
      .filter((conflict) => !conflict.resolved)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 20)
    for (const row of rows) {
      conflicts.push({
        agent_a: row.agent_a,
        agent_b: row.agent_b,
        file: row.file_path ?? "",
        reason: row.description ?? "conflicto activo",
        severity: row.severity ?? "medium",
      })
    }
  } catch { /* no conflicts table */ }

  const levels = buildDashboardLevels(workers)
  let metrics: { token_count?: number; cost?: string; elapsed_secs?: number } = {}
  try {
    const session = (await (await col<SessionDoc>("sessions")).get(sessionId))?.doc
    if (session) {
      metrics = {
        token_count: Number(session.token_count ?? 0),
        cost: `$${Number(session.cost_usd ?? 0).toFixed(2)}`,
        elapsed_secs: Math.max(0, Math.floor((Date.now() - Number(session.started_at ?? Date.now())) / 1000)),
      }
    }
  } catch { /* sessions snapshot unavailable */ }

  if (metrics.token_count === undefined) {
    try {
      const tasks = await findDocsBy<CodeTaskDoc>("codeTasks", "session_id", sessionId)
      if (tasks.length > 0) {
        const tokenCount = tasks.reduce((sum, task) => sum + Number(task.tokens_in ?? 0) + Number(task.tokens_out ?? 0), 0)
        const startedAt = tasks.reduce((min, task) => Math.min(min, ms(task.created_at) || Date.now()), Date.now())
        metrics = {
          token_count: tokenCount,
          cost: "$0.00",
          elapsed_secs: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        }
      }
    } catch { /* code task metrics unavailable */ }
  }

  const securityWorker = workers.find(w => w.name === "security")
  const haltCheckpoint = checkpoints.find(cp => cp.created_by === "halt")

  send({
    type: "dashboard_snapshot",
    workers,
    blackboard_events,
    conflicts,
    levels,
    checkpoints: checkpoints.map(cp => ({
      checkpoint_id: cp.id,
      description: cp.description,
      file_count: cp.file_count,
      agent: cp.created_by ?? "system",
      time: hhmmss(cp.created_at),
    })),
    metrics,
    security: {
      status: securityWorker?.status === "running" ? "WATCHING" : (securityWorker ? String(securityWorker.status).toUpperCase() : "OFFLINE"),
      findings: conflicts.filter(c => c.agent_a === "security" || c.agent_b === "security").length,
    },
    halt: haltCheckpoint ? { active: false, checkpoint_id: haltCheckpoint.id } : { active: false },
  })
}

function buildDashboardLevels(workers: any[]): Array<{ level: number; label: string; agents: string[]; status: string }> {
  const byLevel = new Map<number, any[]>()
  for (const worker of workers) {
    const level = Number(worker.level ?? fallbackWorkerLevel(worker.name))
    const list = byLevel.get(level) ?? []
    list.push(worker)
    byLevel.set(level, list)
  }
  return [0, 1, 2, 3, 4, 5, 6].map(level => {
    const list = byLevel.get(level) ?? []
    const status = list.some(w => w.status === "running")
      ? "active"
      : list.length > 0 && list.every(w => w.status === "done")
        ? "done"
        : "pending"
    return {
      level,
      label: ["PM", "ARC", "ENG", "QA+SEC", "OPS", "VER", "REV", "LIB"][level] ?? `L${level}`,
      agents: list.map(w => w.name),
      status,
    }
  })
}

function fallbackWorkerLevel(name: string): number {
  if (name === "product_manager") return 0
  if (name === "architecture" || name === "architect") return 1
  if (["backend", "frontend", "data_scientist"].includes(name)) return 2
  if (name === "security" || name === "test") return 3
  if (name === "devops") return 4
  if (name === "verifier") return 5
  if (name === "reviewer") return 6
  if (name === "librarian" || name.startsWith("forensic")) return 7
  return 2
}

// ── Settings Snapshot ─────────────────────────────────────────────────────────

async function sendSettingsSnapshot(send: (msg: object) => void): Promise<void> {
  // Cada sección tiene su propio try-catch para que un error en MCP no borre los providers
  let providers: any[] = []
  try {
    const codeConfig = await col<CodeConfigDoc>("codeConfig")
    const defaultProvider = (await codeConfig.get("default_provider"))?.doc.value ?? ""
    const modelsByProvider = new Map<string, ModelDoc[]>()
    for (const model of await scanDocs<ModelDoc>("models")) {
      if (model.model_type !== "llm" || !model.enabled) continue
      const list = modelsByProvider.get(model.provider_id) ?? []
      list.push(model)
      modelsByProvider.set(model.provider_id, list)
    }
    const providerRows = (await scanDocs<ProviderDoc>("providers"))
      .filter((provider) =>
        provider.enabled
        && provider.category === "llm"
        && SUPPORTED_LLM_PROVIDERS.has(provider.id)
        && (modelsByProvider.get(provider.id)?.length ?? 0) > 0
      )
      .sort((a, b) => a.id.localeCompare(b.id))

    providers = await Promise.all(providerRows.map(async (provider) => {
      const configuredModel = (await codeConfig.get(`provider_model_${provider.id}`))?.doc.value ?? ""
      const fallbackModel = (modelsByProvider.get(provider.id) ?? [])
        .sort((a, b) => a.name.localeCompare(b.name))[0]?.id ?? ""
      return {
        id: provider.id,
        name: provider.name ?? provider.id,
        model: configuredModel || fallbackModel,
        is_active: provider.id === defaultProvider,
        has_key: true,
      }
    }))
  } catch { /* providers pueden no existir aún */ }

  let agents: any[] = []
  try {
    const order = ["bee", "scout", "builder", "verifier", "reviewer"]
    agents = (await (await col<AgentDoc>("agents")).scan())
      .map(entry => entry.doc)
      .filter(agent => !!agent.agent_type)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        provider: String(agent.provider_id ?? ""),
        model: String(agent.model_id ?? ""),
        effort: agent.effort ?? "medium",
        max_turns: agent.max_iterations,
        max_input_tokens: agent.max_input_tokens ?? 0,
        max_output_tokens: agent.max_output_tokens ?? 0,
        max_cost_usd: agent.max_cost_usd ?? 0,
        permission_profile: agent.permission_profile ?? "",
      }))
  } catch { /* agents puede no existir */ }

  let mcp: any[] = []
  try {
    mcp = (await (await col<McpServerDoc>("mcpServers")).scan())
      .map((entry) => entry.doc)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(m => ({
        id: String(m.id),
        name: m.name ?? "",
        url: m.url ?? "",
        enabled: m.enabled,
        has_headers: !!m.headers_encrypted,
    }))
  } catch { /* mcpServers puede no existir */ }

  let skills: any[] = []
  try {
    skills = (await (await col<SkillDoc>("skills")).scan())
      .map((entry) => entry.doc)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => ({
        name: s.name ?? "",
        description: s.description ?? "",
        category: s.category ?? "",
        active: s.active,
      }))
  } catch { /* skills puede no existir */ }

  let github_connected = false
  let github_repo: string | null = null
  let telegram_active = false
  try {
    const codeConfig = await col<CodeConfigDoc>("codeConfig")
    github_connected = !!(await codeConfig.get("github_token"))?.doc.value
    github_repo = (await codeConfig.get("github_repo"))?.doc.value ?? null
  } catch { /* config puede no existir */ }
  try {
    const telegram = (await (await col<ChannelDoc>("channels")).get("telegram"))?.doc
      ?? (await scanDocs<ChannelDoc>("channels")).find((channel) => channel.type === "telegram")
    telegram_active = Boolean(telegram?.enabled && telegram.status === "connected")
  } catch { /* channels puede no existir */ }

  send({
    type: "settings_data",
    providers,
    agents,
    mcp,
    skills,
    github_connected,
    github_repo,
    telegram_active,
  })
}
