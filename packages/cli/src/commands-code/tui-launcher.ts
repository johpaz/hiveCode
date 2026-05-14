/**
 * Launch the Ratatui TUI binary and handle IPC with the Bun process.
 *
 * Architecture:
 *   Bun (this file) ←→ Unix socket (JSON-ND) ←→ hivecode-tui (Rust)
 *   Rust owns stdin/stdout (TTY), Bun owns business logic.
 */

import * as path from "node:path"
import * as fs from "node:fs"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import { runProviderSetupWizard } from "@johpaz/hivecode-ui"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

// ── Locate the binary ─────────────────────────────────────────────────────────

function tuiBinPath(): string {
  const releaseBin = path.join(
    import.meta.dir,
    "../../../tui/target/release/hivecode-tui",
  )
  const debugBin = path.join(
    import.meta.dir,
    "../../../tui/target/debug/hivecode-tui",
  )
  if (fs.existsSync(releaseBin)) return releaseBin
  if (fs.existsSync(debugBin))   return debugBin
  return ""
}

export function tuiAvailable(): boolean {
  return tuiBinPath() !== ""
}

// ── IPC message types ─────────────────────────────────────────────────────────

type BunMessage =
  | { type: "init";           mode: string; provider: string; model: string; project_name: string; project_path: string; version: string; task_count: number; token_count: number; agent_count: number }
  | { type: "history_append"; role: string; content: string }
  | { type: "status";         running: boolean; msg: string }
  | { type: "state_update";   new_mode?: string; new_provider?: string; new_model?: string }
  | { type: "suggestions";    items: string[] }
  | { type: "quick_menu";     items: { label: string; cmd: string; desc: string }[] }
  | { type: "shell_output";   stdout: string; stderr: string; exit_code: number }
  | { type: "activity_update"; coordinator: string; phase: string; status: string }
  | { type: "suspend" }
  | { type: "resume" }

type TuiMessage =
  | { type: "ready" }
  | { type: "submit";               input: string }
  | { type: "suggestions_request";  query: string }
  | { type: "mode_change";          mode: string }
  | { type: "shell_execute";        command: string }
  | { type: "suspended" }
  | { type: "exit" }

// ── Callbacks interface ───────────────────────────────────────────────────────

export interface TuiCallbacks {
  initialMode:      string
  initialProvider:  string
  initialModel:     string
  projectName:      string
  projectPath:      string
  version:          string
  taskCount:        number
  tokenCount:       number
  agentCount:       number
  onSubmit:   (input: string) => Promise<{ output: string; newMode?: string; newProvider?: string; newModel?: string }>
  getSuggestions: (query: string) => string[]
  onModeChange?:  (mode: string) => void
  onExit?:        () => void
  /** Mutable ref populated by launchTui so callers can suspend/resume the TUI */
  tuiControl?:    { suspend: (() => Promise<void>) | null; resume: (() => void) | null }
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
    let tuiSocket: import("bun").Socket<undefined> | null = null
    let buf = ""

    const send = (msg: BunMessage) => {
      if (tuiSocket) tuiSocket.write(JSON.stringify(msg) + "\n")
    }

    const suspendTui = (): Promise<void> =>
      new Promise((res) => { suspendedResolve = res; send({ type: "suspend" }) })

    const resumeTui = () => send({ type: "resume" })

    if (callbacks.tuiControl) {
      callbacks.tuiControl.suspend = suspendTui
      callbacks.tuiControl.resume = resumeTui
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
      callbacks.onExit?.()
      server?.stop(true)
      try { fs.unlinkSync(socketPath) } catch { /* ignore */ }
      resolve()
    }).catch(reject)
  })
}

// ── Provider wizard detection ────────────────────────────────────────────────

function isProviderWizardCommand(input: string): boolean {
  // Matches: /provider, /prov, /provider add, /provider add <name>
  return /^\/prov(ider)?(\s+(add(\s+\w+)?)?)?$/i.test(input.trim())
}

// ── Message router ────────────────────────────────────────────────────────────

async function handleTuiMessage(
  msg: TuiMessage,
  send: (m: BunMessage) => void,
  suspendTui: () => Promise<void>,
  resumeTui: () => void,
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
        version:       callbacks.version,
        task_count:    callbacks.taskCount,
        token_count:   callbacks.tokenCount,
        agent_count:   callbacks.agentCount,
      })
      break

    case "suggestions_request": {
      const items = callbacks.getSuggestions(msg.query)
      send({ type: "suggestions", items })
      break
    }

    case "submit": {
      const input = msg.input

      // Provider wizard — suspend TUI, run interactive wizard, resume
      if (isProviderWizardCommand(input)) {
        await suspendTui()
        try {
          const db = getDb()
          const known = (db.query("SELECT id FROM providers ORDER BY id").all() as { id: string }[]).map(r => r.id)
          const result = await runProviderSetupWizard(known, callbacks.version)

          if (result) {
            db.query(`
              INSERT INTO providers (id, name, base_url, api_key_encrypted, enabled)
              VALUES (?,?,?,?,1)
              ON CONFLICT(id) DO UPDATE SET
                base_url = excluded.base_url,
                api_key_encrypted = excluded.api_key_encrypted,
                enabled = 1
            `).run(result.provider, result.provider, result.baseUrl || null, Buffer.from(result.apiKey).toString("base64"))
            db.query("INSERT OR REPLACE INTO code_config (key,value) VALUES ('default_provider',?)").run(result.provider)
            if (result.model)
              db.query("INSERT OR REPLACE INTO code_config (key,value) VALUES (?,?)").run(`provider_model_${result.provider}`, result.model)

            resumeTui()
            send({ type: "state_update", new_provider: result.provider, new_model: result.model || undefined })
            send({ type: "history_append", role: "assistant", content: `✓ Provider ${result.provider} configurado` })
          } else {
            resumeTui()
            send({ type: "history_append", role: "system", content: "(×ᴗ×) Configuración cancelada" })
          }
        } catch (err) {
          resumeTui()
          send({ type: "history_append", role: "system", content: `(×ᴗ×) ${(err as Error).message}` })
        }
        send({ type: "status", running: false, msg: "Listo · [shift+tab] cambiar modo" })
        break
      }

      // Normal command / task execution
      try {
        send({ type: "activity_update", coordinator: "agent", phase: input, status: "thinking" })
        const result = await callbacks.onSubmit(input)
        send({ type: "history_append", role: "assistant", content: result.output })
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
