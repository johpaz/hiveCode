/**
 * Launch the Ratatui TUI binary and handle IPC with the Bun process.
 *
 * Architecture:
 *   Bun (this file) ←→ local IPC (Unix socket or Windows loopback TCP) ←→ hivecode-tui (Rust)
 *   Rust owns stdin/stdout (TTY), Bun owns business logic.
 */

import * as path from "node:path"
import * as fs from "node:fs"
import { logger, onLogEntry, removeLogListener, type LogEntry } from "@johpaz/hivecode-core/utils/logger"
import { createIpcServer } from "@johpaz/hivecode-core/ipc/server"
import type { BunMessage as CoreBunMessage, TuiMessage as CoreTuiMessage } from "@johpaz/hivecode-core/ipc/protocol"
import { broadcastUiMessage, registerUiMessageHandler } from "@johpaz/hivecode-core/ipc/ui-broadcast"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { MessagesRepo } from "@johpaz/hivecode-core/db/repos/messages"
import { CheckpointsRepo } from "@johpaz/hivecode-core/db/repos/checkpoints"
import { FileRisksRepo } from "@johpaz/hivecode-core/db/repos/file-risks"

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
    // Running from dist/ bundle — binary sits next to hivecode.js
    path.join(path.dirname(process.argv[1] || ""), `hivetui${executableSuffix}`),
    path.join(path.dirname(process.argv[1] || ""), `hivecode-tui${executableSuffix}`),
    // Dev mode: hivetui (ratatui-free, preferred)
    path.join(import.meta.dir, `../../../hivetui/target/release/hivetui${executableSuffix}`),
    path.join(import.meta.dir, `../../../hivetui/target/debug/hivetui${executableSuffix}`),
    // Dev mode: legacy packages/tui
    path.join(import.meta.dir, `../../../tui/target/release/hivecode-tui${executableSuffix}`),
    path.join(import.meta.dir, `../../../tui/target/debug/hivecode-tui${executableSuffix}`),
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
  onSubmit:   (input: string) => Promise<{ output: string; newMode?: string; newProvider?: string; newModel?: string }>
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
    const proc = Bun.spawn([binPath], {
      stdin:  "inherit",
      stdout: "inherit",
      stderr: "pipe",
      env:    { ...process.env, HIVECODE_IPC: ipcServer.endpoint },
    })

    if (proc.stderr) {
      const reader = proc.stderr.getReader()
      ;(async () => {
        for await (const chunk of { [Symbol.asyncIterator]: () => ({ next: () => reader.read() }) }) {
          if (process.env.HIVE_DEV) process.stderr.write(chunk)
        }
      })().catch(() => {})
    }

    proc.exited.then(() => {
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
        if (result.newMode || result.newProvider || result.newModel) {
          send({
            type:         "state_update",
            new_mode:     result.newMode,
            new_provider: result.newProvider,
            new_model:    result.newModel,
          })
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
      // hivetui sends rollback requests — forward as system message for now
      send({ type: "history_append", role: "system", content: `↩ Rollback solicitado: ${(msg as { type: string; checkpoint_id?: string }).checkpoint_id ?? "—"}` })
      break
    }
  }
}
