// BunMessage — events from Bun CLI to React UI
export type BunMessage =
  | { type: 'init';              mode: string; provider: string; model: string; project_name: string; project_path: string; session_id: string; version: string; task_count: number; token_count: number; workers: string[] }
  | { type: 'history_append';   role: string; content: string; content_type?: string; agent?: string; timestamp?: string }
  | { type: 'status';            running: boolean; msg: string }
  | { type: 'state_update';      new_mode?: string; new_provider?: string; new_model?: string }
  | { type: 'activity_update';   coordinator: string; phase: string; status: string; display_name?: string; activity?: string }
  | { type: 'workers_snapshot';  workers: { name: string; status: string; detail?: string }[] }
  | { type: 'checkpoint_created'; checkpoint_id: string; description: string; file_count: number; agent: string; tests_passed?: number; tests_total?: number }
  | { type: 'checkpoint_rollback'; checkpoint_id: string; files_restored: number }
  | { type: 'conflict_alert';    agent_a: string; agent_b: string; file: string; reason: string; severity: string; detail?: string | null }
  | { type: 'file_risk_update';  path: string; risk: string; operation: string; adr_ref: string | null; reason: string; agent: string }
  | { type: 'suggestions';       items: string[] }
  | { type: 'log_entry';         timestamp: string; level: string; source: string; message: string }
  | { type: 'adr_update';        path: string; title: string; content: string; status: string }
  | { type: 'narrative_chunk';   coordinator: string; phase: string; content: string }

// TuiMessage — events from React UI to Bun CLI
export type TuiMessage =
  | { type: 'submit';      input: string }
  | { type: 'mode_change'; mode: string }
  | { type: 'rollback';    checkpoint_id: string }
  | { type: 'exit' }

export type UiWsListener = (msg: BunMessage) => void

const UI_WS_URL = import.meta.env.DEV
  ? 'ws://127.0.0.1:16120/ui-ws'
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ui-ws`

export class HiveUiWebSocket {
  private ws: WebSocket | null = null
  private listeners = new Set<UiWsListener>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private _connected = false

  onConnect: (() => void) | null = null
  onDisconnect: (() => void) | null = null

  get connected() { return this._connected }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return

    try {
      this.ws = new WebSocket(UI_WS_URL)

      this.ws.onopen = () => {
        this._connected = true
        this.reconnectDelay = 1000
        this.onConnect?.()
        console.log('[ui-ws] connected to hive gateway')
      }

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as BunMessage
          for (const listener of this.listeners) {
            try { listener(msg) } catch { /* ignore listener errors */ }
          }
        } catch { /* ignore malformed JSON */ }
      }

      this.ws.onclose = () => {
        this._connected = false
        this.onDisconnect?.()
        this.scheduleReconnect()
      }

      this.ws.onerror = () => {
        // onclose fires after onerror, handles reconnect
      }
    } catch {
      this.scheduleReconnect()
    }
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.ws?.close()
    this.ws = null
    this._connected = false
  }

  send(msg: TuiMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  on(listener: UiWsListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
  }
}

export const uiWs = new HiveUiWebSocket()
