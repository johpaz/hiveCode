/**
 * IPC server — wraps Bun.listen and exposes a typed `send()` function.
 * Used by tui-launcher.ts. Not a standalone process — embedded in the Bun gateway.
 * Unix uses a local domain socket; Windows uses loopback TCP because the Rust
 * client cannot open Unix sockets there.
 *
 * Priority model:
 *   critical → sent immediately (conflict alerts, risk updates, init)
 *   normal   → sent in order (narrative chunks, status, history)
 *   low      → sent when socket is idle (logs, checkpoint events)
 */

import type { BunMessage, TuiMessage } from "./protocol.ts"
import { messagePriority } from "./protocol.ts"
import { wrap, serialize } from "./envelope.ts"

export type { BunMessage, TuiMessage }

export interface IpcServer {
  /** Endpoint passed to the Rust client: Unix path or tcp://host:port. */
  endpoint: string
  /** Send a message to the TUI with automatic priority detection. */
  send(msg: BunMessage): void
  /** Send with explicit priority override. */
  sendPriority(msg: BunMessage, override: "critical" | "normal" | "low"): void
  /** Stop the socket server and clean up. */
  stop(): void
}

export interface IpcServerOptions {
  socketPath?: string
  tcp?: { hostname?: string; port?: number }
  /** Session routing metadata included in every Bun -> TUI envelope. */
  sessionId?: string
  onMessage: (msg: TuiMessage) => void
  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (err: Error) => void
}

export function createIpcServer(opts: IpcServerOptions): IpcServer {
  let socket: import("bun").Socket<undefined> | null = null
  let buf = ""

  const rawSend = (msg: BunMessage, priority?: "critical" | "normal" | "low") => {
    if (!socket) return
    const p = priority ?? messagePriority(msg)
    const envelope = wrap(
      p,
      msg as unknown as { type: string } & Record<string, unknown>,
      { sessionId: opts.sessionId },
    )
    socket.write(serialize(envelope))
  }

  const socketHandlers = {
    open(s: import("bun").Socket<undefined>) {
      socket = s
      opts.onConnect?.()
    },
    data(_s: import("bun").Socket<undefined>, chunk: Buffer | Uint8Array) {
      buf += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed) as TuiMessage
          opts.onMessage(msg)
        } catch {
          opts.onError?.(new Error(`Invalid JSON from TUI: ${trimmed.slice(0, 120)}`))
        }
      }
    },
    close(_s: import("bun").Socket<undefined>) {
      socket = null
      opts.onDisconnect?.()
    },
    error(_s: import("bun").Socket<undefined>, err: Error) {
      opts.onError?.(err)
    },
  }

  if (opts.tcp) {
    const hostname = opts.tcp.hostname ?? "127.0.0.1"
    const server = Bun.listen<undefined>({
      hostname,
      port: opts.tcp.port ?? 0,
      socket: socketHandlers,
    })

    return {
      endpoint: `tcp://${hostname}:${server.port}`,
      send: (msg) => rawSend(msg),
      sendPriority: (msg, priority) => rawSend(msg, priority),
      stop: () => server.stop(true),
    }
  }

  if (!opts.socketPath) {
    throw new Error("createIpcServer requires socketPath or tcp transport")
  }

  const server = Bun.listen<undefined>({
    unix: opts.socketPath,
    socket: {
      ...socketHandlers,
    },
  })

  return {
    endpoint: opts.socketPath,
    send: (msg) => rawSend(msg),
    sendPriority: (msg, priority) => rawSend(msg, priority),
    stop: () => server.stop(true),
  }
}
