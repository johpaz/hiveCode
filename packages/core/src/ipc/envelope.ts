import type { IpcPriority } from "./protocol.ts"

/**
 * Wire envelope wrapping each NDJSON line on the socket.
 * Rust's biased select! drains critical before normal before low.
 */
export interface IpcEnvelope {
  protocol_version: 1
  priority: IpcPriority
  seq: number
  session_id?: string
  task_id?: string
  type: string
  payload: unknown
}

export interface IpcEnvelopeContext {
  sessionId?: string
  taskId?: string
}

let _seq = 0

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function wrap(
  priority: IpcPriority,
  msg: { type: string } & Record<string, unknown>,
  context: IpcEnvelopeContext = {},
): IpcEnvelope {
  const { type, ...payload } = msg
  const session_id = context.sessionId ?? stringField(msg.session_id)
  const task_id = context.taskId ?? stringField(msg.task_id)
  return {
    protocol_version: 1,
    priority,
    seq: _seq++,
    ...(session_id ? { session_id } : {}),
    ...(task_id ? { task_id } : {}),
    type,
    payload,
  }
}

export function serialize(envelope: IpcEnvelope): string {
  return JSON.stringify(envelope) + "\n"
}

/** Unwrap an envelope back into a flat BunMessage (for backward compat in tests). */
export function unwrap(env: IpcEnvelope): { type: string } & Record<string, unknown> {
  const payload = env.payload as Record<string, unknown>
  return {
    type: env.type,
    ...(env.session_id && payload.session_id === undefined ? { session_id: env.session_id } : {}),
    ...(env.task_id && payload.task_id === undefined ? { task_id: env.task_id } : {}),
    ...payload,
  }
}
