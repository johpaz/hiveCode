import { EventEmitter } from "events";
import { logger } from "../utils/logger";

export interface EventMap {
  "message:received": {
    channel: string;
    userId: string;
    content: string;
    timestamp: number;
    sessionId: string;
  };
  "message:sent": {
    channel: string;
    userId: string;
    content: string;
    messageId: string;
    sessionId: string;
  };
  "agent:thinking": {
    agentId: string;
    sessionId: string;
    stage: "planning" | "executing" | "responding";
  };
  "agent:response": {
    agentId: string;
    sessionId: string;
    content: string;
    toolsUsed: string[];
    duration: number;
  };
  "tool:executing": {
    toolName: string;
    args: Record<string, unknown>;
    sessionId: string;
  };
  "tool:completed": {
    toolName: string;
    result: unknown;
    duration: number;
    success: boolean;
  };
  "tool:error": {
    toolName: string;
    error: Error;
    args: Record<string, unknown>;
  };
  "error": {
    source: string;
    error: Error;
    context: Record<string, unknown>;
    recoverable: boolean;
  };
  "session:started": {
    sessionId: string;
    agentId: string;
    channel: string;
    userId: string;
  };
  "session:ended": {
    sessionId: string;
    duration: number;
    messageCount: number;
    reason: "completed" | "cancelled" | "error" | "timeout";
  };
  "mcp:connected": {
    serverName: string;
    toolsCount: number;
    resourcesCount: number;
  };
  "mcp:disconnected": {
    serverName: string;
    reason: string;
  };
  "mcp:error": {
    serverName: string;
    error: Error;
  };
  "channel:started": {
    channel: string;
    accountId: string;
  };
  "channel:stopped": {
    channel: string;
    accountId: string;
    reason: string;
  };
  "gateway:started": {
    host: string;
    port: number;
  };
  "gateway:stopped": {
    reason: string;
  };
  "pairing:requested": {
    channel: string;
    userId: string;
    code: string;
    expiresAt: number;
  };
  "pairing:approved": {
    channel: string;
    userId: string;
  };
  "pairing:rejected": {
    channel: string;
    userId: string;
    reason: string;
  };
  "pairing:expired": {
    code: string;
    channel: string;
    userId: string;
  };
  /** Jev served a decision and the caller is applying it. */
  "jev:decision": {
    agentId: string;
    provider: string;
    model: string;
    kind: string;
    summary: string;
    savedTokens: number;
    costUsd: number;
    latencyMs: number;
    eventId: string;
    totals: { decisions: number; savedTokens: number; costUsd: number };
  };
  /** Availability of the decision plane: off / ready / cooling down. */
  "jev:status": {
    state: "off" | "ready" | "fallback";
    oracle?: "jev" | "kev" | null;
    lastError: string | null;
    lastSuccessAt: number | null;
    totals: { decisions: number; savedTokens: number; costUsd: number };
  } | undefined;
  /** An agent started a tool call. Always paired with a `tool:done` of the same `callId`. */
  "tool:call": {
    agentId: string;
    tool: string;
    /** Pairs this call with its completion. */
    callId: string;
    argsSummary: string;
    beeState: string;
    taskId: string | null;
    at: number;
  };
  /** A tool call finished, successfully or not. */
  "tool:done": {
    agentId: string;
    tool: string;
    callId: string;
    ok: boolean;
    durationMs: number;
    resultSummary: string;
    taskId: string | null;
    at: number;
  };
  /**
   * An agent cannot advance until something else happens.
   *
   * `reason` is a short label (`"jev_secuencial"`, `"subagente"`,
   * `"dependencia"`), not a sentence — it names the cause so the UI can group
   * waiting agents by why they are stuck.
   */
  /**
   * La carga efectiva de un agente en un turno.
   *
   * No es el perfil declarado: JEV poda y `search_knowledge` amplía, así que el
   * conjunto cambia aunque no haya descubrimiento nuevo. La ficha del
   * especialista lo necesita para no mentir.
   */
  "agent:loadout": {
    agentId: string;
    tools: string[];
    skills: string[];
    /** De dónde salió el conjunto de herramientas. */
    origen: "perfil" | "jev_pruned";
    /** Skills en la carga mínima: no dependen de descubrir nada. */
    minimal: string[];
    at: number;
  };
  "agent:waiting": {
    agentId: string;
    waitingFor: string[];
    reason: string;
    taskId: string | null;
    at: number;
  };
}

export type EventKey = keyof EventMap;

export interface EventHandler<K extends EventKey> {
  (data: EventMap[K]): void | Promise<void>;
}

class TypedEventBusImpl {
  private emitter = new EventEmitter();
  private logPrefix = "[events]";

  emit<K extends EventKey>(event: K, data: EventMap[K]): void {
    const enrichedData = {
      ...data,
      _eventId: crypto.randomUUID(),
      _timestamp: Date.now(),
      _event: event,
    } as EventMap[K] & { _eventId: string; _timestamp: number; _event: string };

    this.emitter.emit(event, enrichedData);

    if (process.env.DEBUG_EVENTS === "true") {
      logger.debug(`${this.logPrefix} emitted: ${event}`, { data });
    }
  }

  on<K extends EventKey>(event: K, handler: EventHandler<K>): () => void {
    this.emitter.on(event, handler);
    return () => this.off(event, handler);
  }

  once<K extends EventKey>(event: K, handler: EventHandler<K>): void {
    this.emitter.once(event, handler);
  }

  off<K extends EventKey>(event: K, handler: EventHandler<K>): void {
    this.emitter.off(event, handler);
  }

  removeAllListeners<K extends EventKey>(event?: K): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  listenerCount<K extends EventKey>(event: K): number {
    return this.emitter.listenerCount(event);
  }
}

export const eventBus = new TypedEventBusImpl();

export type TypedEventBus = typeof eventBus;
