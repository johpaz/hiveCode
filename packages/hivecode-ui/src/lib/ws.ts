export interface WsMessage {
  type: string;
  sessionId?: string;
  status?: { state: string; model?: string; channel?: string };
  logEntry?: {
    timestamp: string;
    level: string;
    source: string;
    message: string;
  };
  content?: string;
  channel?: string;
  data?: Record<string, unknown>;
}

export type WsListener = (msg: WsMessage) => void;

const WS_BASE_URL = (() => {
  // In Vite dev mode, connect to the gateway WebSocket directly
  // because the Vite dev server (5173) is not the gateway (16120)
  if (import.meta.env.DEV) {
    return 'ws://127.0.0.1:16120/ws';
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${proto}//${host}/ws`;
})();

/**
 * Fetch the gateway token from the local dev endpoint.
 * Returns null if not available (e.g., production or token not configured).
 */
async function fetchGatewayToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/token');
    if (!res.ok) return null;
    const data = await res.json();
    return data.token || null;
  } catch {
    return null;
  }
}

export class HiveWebSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<WsListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private url: string;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private gatewayToken: string | null = null;
  private sessionId: string;

  constructor(url = WS_BASE_URL) {
    this.url = url;
    this.sessionId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    // Obtain gateway token before connecting
    if (!this.gatewayToken) {
      this.gatewayToken = await fetchGatewayToken();
    }

    const url = new URL(this.url);
    if (this.gatewayToken) {
      url.searchParams.set('token', this.gatewayToken);
    }
    url.searchParams.set('session', this.sessionId);

    try {
      this.ws = new WebSocket(url.toString());

      this.ws.onopen = () => {
        console.log('[hive-ws] connected');
        this.reconnectDelay = 1000;
        this.startPing();
        this.emit({ type: 'connected' });
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsMessage;
          this.emit(msg);
        } catch {
          console.warn('[hive-ws] invalid JSON:', event.data);
        }
      };

      this.ws.onclose = () => {
        console.log('[hive-ws] disconnected');
        this.stopPing();
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('[hive-ws] error:', err);
      };
    } catch (err) {
      console.error('[hive-ws] failed to connect:', err);
      this.scheduleReconnect();
    }
  }

  disconnect() {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  subscribeLogs() {
    this.send({ type: 'logs_subscribe' });
  }

  subscribeTask(taskId: string) {
    this.send({ type: 'task_subscribe', metadata: { taskId } });
  }

  unsubscribeTask(taskId: string) {
    this.send({ type: 'task_unsubscribe', metadata: { taskId } });
  }

  on(listener: WsListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onMessage(listener: WsListener) {
    const unsubscribe = this.on(listener);
    return () => { unsubscribe(); };
  }

  private emit(msg: WsMessage) {
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (err) {
        console.error('[hive-ws] listener error:', err);
      }
    }
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, 30000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}

// Singleton instance
export const hiveWs = new HiveWebSocket();
