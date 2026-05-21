/**
 * IPC server — wraps Bun.listen<unix> and exposes a typed `send()` function.
 * Used by tui-launcher.ts. Not a standalone process — embedded in the Bun gateway.
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
  /** Send a message to the TUI with automatic priority detection. */
  send(msg: BunMessage): void
  /** Send with explicit priority override. */
  sendPriority(msg: BunMessage, override: "critical" | "normal" | "low"): void
  /** Stop the socket server and clean up. */
  stop(): void
}

export interface IpcServerOptions {
  socketPath: string
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
    const envelope = wrap(p, msg as unknown as { type: string } & Record<string, unknown>)
    socket.write(serialize(envelope))
  }

  const server = Bun.listen<undefined>({
    unix: opts.socketPath,
    socket: {
      open(s) {
        socket = s
        opts.onConnect?.()
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
            opts.onMessage(msg)
          } catch {
            opts.onError?.(new Error(`Invalid JSON from TUI: ${trimmed.slice(0, 120)}`))
          }
        }
      },
      close(_s) {
        socket = null
        opts.onDisconnect?.()
      },
      error(_s, err) {
        opts.onError?.(err as Error)
      },
    },
  })

  return {
    send: (msg) => rawSend(msg),
    sendPriority: (msg, priority) => rawSend(msg, priority),
    stop: () => server.stop(true),
  }
}
