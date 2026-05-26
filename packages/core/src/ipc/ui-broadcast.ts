import type { BunMessage, TuiMessage } from './protocol'

type BroadcastFn = (msg: BunMessage) => void
type MessageHandler = (msg: TuiMessage) => void

let broadcastFn: BroadcastFn | null = null
let messageHandler: MessageHandler | null = null
let lastInitMsg: BunMessage | null = null

export function registerUiBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn
}

export function broadcastUiMessage(msg: BunMessage): void {
  if (msg.type === 'init') lastInitMsg = msg
  broadcastFn?.(msg)
}

/** Returns the last init message sent to the UI, or null if none yet. */
export function getLastUiInit(): BunMessage | null {
  return lastInitMsg
}

export function registerUiMessageHandler(fn: MessageHandler): void {
  messageHandler = fn
}

export function hasUiMessageHandler(): boolean {
  return messageHandler !== null
}

export function handleUiMessage(msg: TuiMessage): void {
  messageHandler?.(msg)
}
