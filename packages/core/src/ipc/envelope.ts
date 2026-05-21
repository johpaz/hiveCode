import type { IpcPriority } from "./protocol.ts"

/**
 * Wire envelope wrapping each NDJSON line on the socket.
 * Rust's biased select! drains critical before normal before low.
 */
export interface IpcEnvelope {
  priority: IpcPriority
  seq: number
  type: string
  payload: unknown
}

let _seq = 0

export function wrap(priority: IpcPriority, msg: { type: string } & Record<string, unknown>): IpcEnvelope {
  const { type, ...payload } = msg
  return { priority, seq: _seq++, type, payload }
}

export function serialize(envelope: IpcEnvelope): string {
  return JSON.stringify(envelope) + "\n"
}

/** Unwrap an envelope back into a flat BunMessage (for backward compat in tests). */
export function unwrap(env: IpcEnvelope): { type: string } & Record<string, unknown> {
  return { type: env.type, ...(env.payload as Record<string, unknown>) }
}
