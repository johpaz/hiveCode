/**
 * Launch the Ratatui TUI binary and handle IPC with the Bun process.
 *
 * Architecture:
 *   Bun (this file) ←→ Unix socket (JSON-ND) ←→ hivecode-tui (Rust)
 *   Rust owns stdin/stdout (TTY), Bun owns business logic.
 */

import * as path from "node:path"
import * as fs from "node:fs"
import { logger, onLogEntry, removeLogListener, type LogEntry } from "@johpaz/hivecode-core/utils/logger"

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
  const candidates = [
    // Running from dist/ bundle — binary sits next to hivecode.js
    path.join(path.dirname(process.argv[1] || ""), "hivecode-tui"),
    // Dev mode: source tree (packages/cli/src/commands-code/ → packages/tui/)
    path.join(import.meta.dir, "../../../tui/target/release/hivecode-tui"),
    path.join(import.meta.dir, "../../../tui/target/debug/hivecode-tui"),
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

export type BunMessage =
  | { type: "init";           mode: string; provider: string; model: string; project_name: string; project_path: string; session_id: string; version: string; task_count: number; token_count: number; agent_count: number }
  | { type: "history_append"; role: string; content: string; content_type?: string }
  | { type: "status";         running: boolean; msg: string }
  | { type: "state_update";   new_mode?: string; new_provider?: string; new_model?: string }
  | { type: "suggestions";    items: string[] }
  | { type: "quick_menu";     items: { label: string; cmd: string; desc: string }[] }
  | { type: "shell_output";   stdout: string; stderr: string; exit_code: number }
  | { type: "activity_update"; coordinator: string; phase: string; status: string }
  | { type: "log_entry"; timestamp: string; level: string; source: string; message: string }
  | { type: "narrative_chunk"; coordinator: string; phase: string; content: string; content_type?: string; stream_id?: string }
  | { type: "show_config_modal"; command: string; title: string; fields: ModalField[] }
  | { type: "show_info_modal"; title: string; content: string }
  | { type: "suspend" }
  | { type: "resume" }

type TuiMessage =
  | { type: "ready" }
  | { type: "submit";               input: string }
  | { type: "suggestions_request";  query: string }
  | { type: "mode_change";          mode: string }
  | { type: "shell_execute";        command: string }
  | { type: "modal_submit";         command: string; values: Record<string, string> }
  | { type: "modal_cancel";         command: string }
  | { type: "info_modal_close" }
  | { type: "suspended" }
  | { type: "exit" }

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
  agentCount:       number
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
      "hivecode-tui binary not found.\n" +
      "Build it with:  cd packages/tui && cargo build",
    )
  }

  const socketPath = `/tmp/hivecode-${process.pid}.sock`

  // Clean up any leftover socket
  try { fs.unlinkSync(socketPath) } catch { /* ignore */ }

  return new Promise((resolve, reject) => {
    // Resolves when Rust confirms it has released the TTY
    let suspendedResolve: (() => void) | null = null
    let modalResolve: ((values: Record<string, string> | null) => void) | null = null
    let infoModalResolve: (() => void) | null = null
    let tuiSocket: import("bun").Socket<undefined> | null = null
    let buf = ""

    const send = (msg: BunMessage) => {
      if (tuiSocket) tuiSocket.write(JSON.stringify(msg) + "\n")
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

    // ── IPC server (Bun native unix socket) ────────────────────────────────
    let server: ReturnType<typeof Bun.listen> | null = null
    try {
      server = Bun.listen<undefined>({
        unix: socketPath,
        socket: {
          open(s) {
            tuiSocket = s
          },
          data(_s, chunk) {
            buf += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
            const lines = buf.split("\n")
            buf = lines.pop() ?? ""

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              try {
                const msg = JSON.parse(trimmed) as TuiMessage

                if (msg.type === "suspended") {
                  suspendedResolve?.()
                  suspendedResolve = null
                  continue
                }

                if (msg.type === "modal_submit") {
                  modalResolve?.(msg.values)
                  modalResolve = null
                  continue
                }

                if (msg.type === "modal_cancel") {
                  modalResolve?.(null)
                  modalResolve = null
                  continue
                }

                if (msg.type === "info_modal_close") {
                  infoModalResolve?.()
                  infoModalResolve = null
                  continue
                }

                handleTuiMessage(msg, send, suspendTui, resumeTui, callbacks).catch((err) => {
                  logger.error("[tui-ipc] handler error", err)
                  send({ type: "history_append", role: "system", content: `(×ᴗ×) ${(err as Error).message}` })
                  send({ type: "status", running: false, msg: "Error" })
                })
              } catch {
                logger.warn("[tui-ipc] invalid JSON:", trimmed)
              }
            }
          },
          close(_s) {
            tuiSocket = null
          },
          error(_s, err) {
            logger.warn("[tui-ipc] socket error:", (err as Error).message)
          },
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
      env:    { ...process.env, HIVECODE_IPC: socketPath },
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
      server?.stop(true)
      try { fs.unlinkSync(socketPath) } catch { /* ignore */ }
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
        agent_count:   callbacks.agentCount,
      })
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
        send({ type: "history_append", role: "assistant", content: result.output, content_type: isLikelyMarkdown(result.output) ? "markdown" : "plain" })
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
      break
  }
}
