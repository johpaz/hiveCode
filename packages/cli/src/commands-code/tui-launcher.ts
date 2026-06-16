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
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { MessagesRepo } from "@johpaz/hivecode-core/db/repos/messages"
import { CheckpointsRepo } from "@johpaz/hivecode-core/db/repos/checkpoints"
import { FileRisksRepo } from "@johpaz/hivecode-core/db/repos/file-risks"
import { restoreFiles } from "@johpaz/hivecode-code/checkpoint/rollback"

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

function tuiBinPath(): string {
  const executableSuffix = process.platform === "win32" ? ".exe" : ""
  const candidates = [
    // Extracted from embedded binary (compiled single-binary mode)
    cachedHivetuiPath(),
    // Running from dist/ bundle — binary sits next to hivecode
    path.join(path.dirname(process.argv[1] || ""), `hivetui${executableSuffix}`),
    path.join(path.dirname(process.argv[1] || ""), `hivecode-tui${executableSuffix}`),
    // Dev mode
    path.join(import.meta.dir, `../../../hivetui/target/release/hivetui${executableSuffix}`),
    path.join(import.meta.dir, `../../../hivetui/target/debug/hivetui${executableSuffix}`),
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
  getSuggestions: (query: string) => string[]
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
      handleTuiMessage(msg, send, suspendTui, resumeTui, callbacks).catch((err) => {
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
            sendSettingsSnapshot(send)
            return
          }
          handleTuiMessage(msg, send, suspendTui, resumeTui, callbacks).catch((err) => {
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
  _suspendTui: () => Promise<void>,
  _resumeTui: () => void,
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
      // Dump SQLite state so TUI can rebuild session on startup
      try {
        const db = getDb()
        const msgsRepo  = new MessagesRepo(db)
        const cpsRepo   = new CheckpointsRepo(db)
        const risksRepo = new FileRisksRepo(db)

        // Recent conversation history (last 50, sent oldest-first)
        const msgs = msgsRepo.list(callbacks.sessionId, 50)
        for (const m of msgs.reverse()) {
          send({ type: "history_append", role: m.role, content: m.content,
                 content_type: m.content_type === "diff" ? "plain" : m.content_type,
                 agent: (m as any).agent,
                 timestamp: (m as any).timestamp })
        }

        // Checkpoint timeline (last 20, sent oldest-first)
        const cps = cpsRepo.list(callbacks.sessionId, 20)
        for (const cp of cps.reverse()) {
          send({ type: "checkpoint_created", checkpoint_id: cp.id,
                 description: cp.description, file_count: cp.file_count,
                 agent: cp.created_by ?? "system" })
        }

        // Active file risks for this session
        const risks = risksRepo.listBySession(callbacks.sessionId)
        for (const r of risks) {
          send({ type: "file_risk_update", path: r.file_path, risk: r.risk_level,
                 operation: r.operation ?? "modified", adr_ref: r.adr_ref,
                 reason: r.reason ?? "", agent: r.agent ?? "system" })
        }

        // ADRs for this project
        const adrs = db.query(
          "SELECT file_path, title, content, status FROM adrs ORDER BY updated_at DESC LIMIT 10"
        ).all() as { file_path: string; title: string; content: string; status: string }[]
        for (const adr of adrs) {
          send({ type: "adr_update", path: adr.file_path, title: adr.title,
                 content: adr.content, status: adr.status ?? "accepted" })
        }

        sendDashboardSnapshot(send, db, callbacks.sessionId, cps)
      } catch (e) {
        logger.warn("[tui-ipc] init snapshot failed:", (e as Error).message)
      }
      send({ type: "status", running: false, msg: "Listo · escribe tu tarea" })
      break

    case "suggestions_request": {
      const items = callbacks.getSuggestions(msg.query)
      console.error(`[tui-ipc] suggestions_request query="${msg.query}" -> ${items.length} items`)
      send({ type: "suggestions", items })
      break
    }

    case "submit": {
      const input = msg.input
      try {
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
          sendSettingsSnapshot(send)
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

    case "shell_execute": {
      const cmd = msg.command
      try {
        send({ type: "activity_update", coordinator: "shell", phase: cmd, status: "running" })
        const proc = Bun.spawn({
          cmd: ["bash", "-c", cmd],
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: process.env.PATH || "/usr/bin:/bin" },
          timeout: 30_000,
        })
        const stdout = await new Response(proc.stdout).text()
        const stderr = await new Response(proc.stderr).text()
        const exitCode = proc.exitCode ?? -1
        send({ type: "shell_output", stdout, stderr, exit_code: exitCode })
        send({ type: "activity_update", coordinator: "", phase: "", status: "idle" })
      } catch (err) {
        send({ type: "shell_output", stdout: "", stderr: (err as Error).message, exit_code: -1 })
        send({ type: "activity_update", coordinator: "", phase: "", status: "idle" })
      }
      break
    }

    case "mode_change":
      callbacks.onModeChange?.(msg.mode)
      break

    case "exit":
    case "quit":
      break

    case "rollback": {
      const checkpointId = (msg as { type: string; checkpoint_id?: string }).checkpoint_id
      if (!checkpointId) {
        send({ type: "history_append", role: "system", content: "↩ Rollback sin checkpoint_id" })
        break
      }
      try {
        const db = getDb()
        const repo = new CheckpointsRepo(db)
        const files = repo.getFiles(checkpointId)
        const restored = await restoreFiles(files)
        repo.markRestored(checkpointId)
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

function sendDashboardSnapshot(
  send: (m: BunMessage) => void,
  db: ReturnType<typeof getDb>,
  sessionId: string,
  checkpoints: Array<{ id: string; description: string; file_count: number; created_by?: string; created_at: number }>,
): void {
  const workers: any[] = []
  try {
    const rows = db.query(
      `SELECT worker, phase, level, status, current_action, input_tokens, output_tokens, started_at, completed_at
       FROM worker_activity
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT 100`,
    ).all(sessionId) as any[]
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.worker)) continue
      seen.add(row.worker)
      workers.push({
        name: row.worker,
        status: row.status ?? "waiting",
        detail: row.phase ?? "",
        activity: row.current_action ?? row.phase ?? "",
        current_action: row.current_action ?? row.phase ?? "",
        level: Number(row.level ?? 0),
        token_count: Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0),
      })
    }
  } catch { /* session may predate worker_activity */ }

  const blackboard_events: any[] = []
  try {
    const rows = db.query(
      `SELECT agent, type, content, created_at
       FROM agent_context
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 60`,
    ).all(sessionId) as any[]
    for (const row of rows.reverse()) {
      blackboard_events.push({
        timestamp: hhmmss(Number(row.created_at ?? Date.now())),
        agent: row.agent ?? "agent",
        event_type: String(row.type ?? "observation").toUpperCase(),
        content: row.content ?? "",
      })
    }
  } catch { /* agent_context may be absent in older DBs */ }

  const conflicts: any[] = []
  try {
    const rows = db.query(
      `SELECT agent_a, agent_b, file_path, description, severity
       FROM agent_conflicts
       WHERE session_id = ? AND resolved = 0
       ORDER BY created_at DESC
       LIMIT 20`,
    ).all(sessionId) as any[]
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
    const session = db.query(
      "SELECT token_count, cost_usd, started_at FROM sessions WHERE id = ? LIMIT 1",
    ).get(sessionId) as any
    if (session) {
      metrics = {
        token_count: Number(session.token_count ?? 0),
        cost: `$${Number(session.cost_usd ?? 0).toFixed(2)}`,
        elapsed_secs: Math.max(0, Math.floor((Date.now() - Number(session.started_at ?? Date.now())) / 1000)),
      }
    }
  } catch { /* sessions snapshot unavailable */ }

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
      label: ["PM", "ARC", "ENG", "QA+SEC", "OPS", "REV", "LIB"][level] ?? `L${level}`,
      agents: list.map(w => w.name),
      status,
    }
  })
}

function fallbackWorkerLevel(name: string): number {
  if (name === "product_manager") return 0
  if (name === "architecture" || name === "architect") return 1
  if (["backend", "frontend", "mobile", "data_scientist", "dba", "integration"].includes(name)) return 2
  if (name === "security" || name === "test") return 3
  if (name === "devops") return 4
  if (name === "reviewer") return 5
  if (name === "librarian" || name.startsWith("forensic")) return 6
  return 2
}

// ── Settings Snapshot ─────────────────────────────────────────────────────────

function sendSettingsSnapshot(send: (msg: object) => void): void {
  const db = getDb()

  // Cada sección tiene su propio try-catch para que un error en MCP no borre los providers
  let providers: any[] = []
  try {
    const defaultProvider = (db.query(
      "SELECT value FROM code_config WHERE key = 'default_provider'"
    ).get() as any)?.value ?? ""

    providers = (db.query(
      "SELECT id, name, enabled FROM providers WHERE enabled = 1 ORDER BY id"
    ).all() as any[]).map(p => ({
      id: p.id,
      name: p.name ?? p.id,
      model: (db.query("SELECT value FROM code_config WHERE key = ?")
        .get(`provider_model_${p.id}`) as any)?.value ?? "",
      is_active: p.id === defaultProvider,
      has_key: true,
    }))
  } catch { /* tabla providers no existe aún */ }

  let mcp: any[] = []
  try {
    mcp = (db.query(
      "SELECT id, name, url, enabled, headers_encrypted FROM mcp_servers ORDER BY name"
    ).all() as any[]).map(m => ({
      id: String(m.id),
      name: m.name ?? "",
      url: m.url ?? "",
      enabled: m.enabled === 1,
      has_headers: !!m.headers_encrypted,
    }))
  } catch { /* mcp_servers puede no existir */ }

  let skills: any[] = []
  try {
    skills = (db.query(
      "SELECT name, description, category, active FROM skills ORDER BY name"
    ).all() as any[]).map(s => ({
      name: s.name ?? "",
      description: s.description ?? "",
      category: s.category ?? "",
      active: s.active === 1,
    }))
  } catch { /* skills puede no existir */ }

  let github_connected = false
  let github_repo: string | null = null
  let telegram_active = false
  try {
    const configTable = "agent_config"
    github_connected = !!(db.query(`SELECT value FROM ${configTable} WHERE key = 'github_token' LIMIT 1`).get() as any)?.value
    github_repo = (db.query(`SELECT value FROM ${configTable} WHERE key = 'github_repo' LIMIT 1`).get() as any)?.value ?? null
  } catch { /* agent_config puede no existir */ }
  try {
    telegram_active = !!(db.query(`SELECT id FROM channels WHERE id = 'telegram' AND enabled = 1 AND status = 'connected' LIMIT 1`).get())
  } catch { /* channels puede no existir */ }

  send({
    type: "settings_data",
    providers,
    mcp,
    skills,
    github_connected,
    github_repo,
    telegram_active,
  })
}
