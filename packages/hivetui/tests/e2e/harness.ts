/**
 * Shared E2E harness for the hivetui binary.
 *
 * Spawns the real compiled TUI in headless mode, acts as the Bun side of the
 * IPC contract (NDJSON envelopes over a loopback socket) and exposes the
 * rendered canvas frames the binary emits on stdout.
 *
 * Nothing here is mocked: the binary runs, deserializes real envelopes with
 * serde, drives the real state machine and renders through the real Canvas.
 *
 * Requires a debug build:
 *   cargo build --manifest-path packages/hivetui/Cargo.toml
 */

import { createServer, type AddressInfo, type Server } from "node:net"
import { existsSync, unlinkSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const BINARY = path.resolve(import.meta.dir, "../../target/debug/hivetui")

export type BunMessage = Record<string, unknown> & { type: string }

export type SendOptions = {
  priority?: "critical" | "normal" | "low"
  sessionId?: string
  taskId?: string
}

/** One rendered frame as emitted by `app.rs` in headless mode. */
export type FrameSnapshot = {
  frame: number
  tab: string
  mode: string
  running: boolean
  rows: string[]
}

export type IpcConnection = {
  send: (msg: BunMessage, options?: SendOptions) => void
  /** Resolves with the first inbound TUI message of `type`. */
  waitForMessage: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** Every TUI→Bun message received so far, in arrival order. */
  received: Record<string, unknown>[]
  close: () => void
}

export type IpcServer = {
  endpoint: string
  server: Server
  waitForConnection: () => Promise<IpcConnection>
}

/** Wraps the first inbound connection in the Bun-side IPC contract. */
function acceptConnection(server: Server): () => Promise<IpcConnection> {
  return () =>
    new Promise<IpcConnection>((resolve) => {
      server.once("connection", (socket) => {
        let seq = 0

        // The TUI answers with NDJSON too (ready, submit, suspended, …).
        const received: Record<string, unknown>[] = []
        const waiters: { type: string; resolve: (msg: Record<string, unknown>) => void }[] = []
        let inbound = ""
        socket.on("data", (chunk) => {
          inbound += chunk.toString()
          const lines = inbound.split("\n")
          inbound = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.trim()) continue
            let parsed: Record<string, unknown>
            try { parsed = JSON.parse(line) } catch { continue }
            received.push(parsed)
            const index = waiters.findIndex(w => w.type === parsed.type)
            if (index >= 0) waiters.splice(index, 1)[0]!.resolve(parsed)
          }
        })

        const waitForMessage = (type: string, timeoutMs = 5000) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const already = received.find(m => m.type === type)
            if (already) return resolve(already)
            const timer = setTimeout(
              () => reject(new Error(`waitForMessage: timeout waiting for TUI message "${type}"`)),
              timeoutMs,
            )
            waiters.push({ type, resolve: (msg) => { clearTimeout(timer); resolve(msg) } })
          })

        const send = (msg: BunMessage, options: SendOptions = {}) => {
          const { type, ...payload } = msg
          // Mirrors packages/core/src/ipc/envelope.ts `wrap()` + `serialize()`.
          socket.write(JSON.stringify({
            protocol_version: 1,
            priority: options.priority ?? "normal",
            seq: seq++,
            ...(options.sessionId ? { session_id: options.sessionId } : {}),
            ...(options.taskId ? { task_id: options.taskId } : {}),
            type,
            payload,
          }) + "\n")
        }
        resolve({ send, waitForMessage, received, close: () => socket.destroy() })
      })
    })
}

/** Loopback TCP IPC server — the transport hivetui uses on Windows. */
export async function createTcpIpcServer(): Promise<IpcServer> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve)
    server.once("error", reject)
    server.listen(0, "127.0.0.1")
  })
  const address = server.address() as AddressInfo

  return {
    endpoint: `tcp://127.0.0.1:${address.port}`,
    server,
    waitForConnection: acceptConnection(server),
  }
}

/** Unix-socket IPC server — the transport hivetui uses on Linux and macOS. */
export async function createUnixIpcServer(socketPath?: string): Promise<IpcServer> {
  const endpoint = socketPath
    ?? path.join(os.tmpdir(), `hivetui-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`)
  if (existsSync(endpoint)) unlinkSync(endpoint)

  const server = createServer()
  // `listen` is async: without awaiting it the binary can try to connect
  // before the socket file exists.
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve)
    server.once("error", reject)
    server.listen(endpoint)
  })

  return { endpoint, server, waitForConnection: acceptConnection(server) }
}

/** Spawns the real binary in headless mode and streams its canvas frames. */
export async function spawnTui(
  endpoint: string,
  size: { cols?: number; rows?: number } = {},
): Promise<{ frames: () => AsyncGenerator<FrameSnapshot>; kill: () => void }> {
  const proc = Bun.spawn({
    cmd: [BINARY],
    stdout: "pipe",
    stderr: "ignore",
    env: {
      ...process.env,
      HIVETUI_HEADLESS: "1",
      HIVECODE_IPC: endpoint,
      HIVETUI_COLS: String(size.cols ?? 120),
      HIVETUI_ROWS: String(size.rows ?? 30),
    },
  })

  async function* frames(): AsyncGenerator<FrameSnapshot> {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.trim()) continue
          try { yield JSON.parse(line) as FrameSnapshot } catch { /* partial line */ }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  return { frames, kill: () => proc.kill() }
}

/** Resolves with the first frame satisfying `predicate`, or rejects on timeout. */
export async function waitForFrame(
  iter: AsyncGenerator<FrameSnapshot>,
  predicate: (frame: FrameSnapshot) => boolean,
  timeoutMs = 5000,
  label = "predicate",
): Promise<FrameSnapshot> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`waitForFrame: timeout waiting for ${label}`)),
      timeoutMs,
    )
  })
  try {
    while (true) {
      const result = await Promise.race([iter.next(), timeout])
      if (result.done) break
      if (predicate(result.value)) return result.value
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
  throw new Error(`waitForFrame: stream ended before ${label} matched`)
}

/** True when any rendered row contains `text`. */
export function frameContains(frame: FrameSnapshot, text: string): boolean {
  return frame.rows.some(row => row.includes(text))
}

/** The whole frame as a single string — handy for negative assertions. */
export function frameText(frame: FrameSnapshot): string {
  return frame.rows.join("\n")
}

export type SessionOptions = {
  cols?: number
  rows?: number
  /** Unix sockets on Linux/macOS, loopback TCP on Windows. Defaults to TCP. */
  transport?: "tcp" | "unix"
}

/** Boots a TUI already connected and initialised in `mode`. */
export async function startSession(mode: string, options: SessionOptions = {}): Promise<{
  ipc: IpcConnection
  iter: AsyncGenerator<FrameSnapshot>
  sessionId: string
  /** The frame rendered right after `init`. Headless emits frames only on
   *  inbound messages, so this is the only chance to inspect it. */
  initFrame: FrameSnapshot
  dispose: () => void
}> {
  const { transport = "tcp", ...size } = options
  const { endpoint, server, waitForConnection } = transport === "unix"
    ? await createUnixIpcServer()
    : await createTcpIpcServer()
  const { frames, kill } = await spawnTui(endpoint, size)
  const iter = frames()
  const ipc = await waitForConnection()
  await iter.next() // frame 0 — empty welcome state

  const sessionId = `e2e-${mode}-${Date.now()}`
  ipc.send({
    type: "init",
    session_id: sessionId,
    workers: ["bee", "backend", "frontend", "security", "test", "devops"],
    mode,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    project_name: "hiveCode",
    project_path: "/tmp/hiveCode",
    version: "1.0.0",
    task_count: 0,
    token_count: 0,
  }, { priority: "critical", sessionId })
  const initFrame = await waitForFrame(iter, f => f.mode === mode, 5000, `init(${mode})`)

  return {
    ipc,
    iter,
    sessionId,
    initFrame,
    dispose: () => {
      try { ipc.close() } finally {
        kill()
        server.close()
        // Unix sockets leave a file behind.
        if (transport === "unix" && existsSync(endpoint)) {
          try { unlinkSync(endpoint) } catch { /* already gone */ }
        }
      }
    },
  }
}
