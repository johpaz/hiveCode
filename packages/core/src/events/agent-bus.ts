/**
 * Agent Bus - Sistema de mensajería pub/sub para comunicación entre workers
 * 
 * Permite que los workers se comuniquen entre sí sin pasar por el coordinador.
 * Útil para:
 * - Notificar completado de tareas con dependencias
 * - Solicitar ayuda entre workers
 * - Compartir resultados intermedios
 * - Coordinar ejecución en paralelo
 */

import { EventEmitter } from "events";
import { logger } from "../utils/logger";
import { col } from "../storage/hive";
import type { AgentBusMessageDoc } from "../storage/collections";

const log = logger.child("agent-bus");

// ─── Tipos de eventos ────────────────────────────────────────────────────────

export interface AgentBusEventMap {
  "worker:task_started": {
    workerId: string;
    workerName: string;
    taskId: number;
    taskName: string;
    projectId: string;
    timestamp: number;
  };
  "worker:task_completed": {
    workerId: string;
    workerName: string;
    taskId: number;
    taskName: string;
    projectId: string;
    result: string;
    timestamp: number;
  };
  "worker:task_failed": {
    workerId: string;
    workerName: string;
    taskId: number;
    taskName: string;
    projectId: string;
    error: string;
    timestamp: number;
  };
  "worker:help_request": {
    fromWorkerId: string;
    fromWorkerName: string;
    taskId: number;
    request: string;
    requiredSkill?: string;
    timestamp: number;
  };
  "worker:help_response": {
    toWorkerId: string;
    fromWorkerId: string;
    fromWorkerName: string;
    taskId: number;
    response: string;
    timestamp: number;
  };
  "worker:blocked": {
    workerId: string;
    workerName: string;
    taskId: number;
    blockedBy: string;
    reason: string;
    timestamp: number;
  };
  "worker:unblocked": {
    workerId: string;
    workerName: string;
    taskId: number;
    unblockedBy: string;
    timestamp: number;
  };
  "project:started": {
    projectId: string;
    projectName: string;
    coordinatorId: string;
    timestamp: number;
  };
  "project:completed": {
    projectId: string;
    projectName: string;
    coordinatorId: string;
    summary: string;
    timestamp: number;
  };
  "message:custom": {
    fromWorkerId: string;
    fromWorkerName: string;
    toWorkerId?: string;
    topic: string;
    content: string;
    timestamp: number;
  };
}

export type AgentBusEventKey = keyof AgentBusEventMap;

export interface AgentBusEventHandler<K extends AgentBusEventKey> {
  (data: AgentBusEventMap[K]): void | Promise<void>;
}

// ─── Message Store - Persistencia de mensajes en BD ─────────────────────────

export interface AgentBusMessage {
  id: string;
  event_type: string;
  from_worker_id: string;
  to_worker_id: string;
  topic: string | null;
  content: string;
  metadata: string | null;
  created_at: number;
  read: boolean;
}

const messageCache: AgentBusMessage[] = [];

/**
 * Guarda un mensaje en la base de datos para persistencia
 */
function persistMessage(event: AgentBusEventKey, data: any, metadata?: Record<string, unknown>): void {
  // Extraer IDs de worker según el tipo de evento
  let fromWorkerId = "";
  let toWorkerId = "";
  let topic: string | null = null;
  let content: string;

  switch (event) {
    case "worker:task_started":
    case "worker:task_completed":
    case "worker:task_failed":
      fromWorkerId = (data as any).workerId || "";
      topic = event;
      content = JSON.stringify(data);
      break;
    case "worker:help_request":
      fromWorkerId = (data as any).fromWorkerId || "";
      topic = "help_request";
      content = (data as any).request || "";
      break;
    case "worker:help_response":
      fromWorkerId = (data as any).fromWorkerId || "";
      toWorkerId = (data as any).toWorkerId || "";
      topic = "help_response";
      content = (data as any).response || "";
      break;
    case "worker:blocked":
    case "worker:unblocked":
      fromWorkerId = (data as any).workerId || "";
      topic = event;
      content = JSON.stringify(data);
      break;
    case "message:custom":
      fromWorkerId = (data as any).fromWorkerId || "";
      toWorkerId = (data as any).toWorkerId || "";
      topic = (data as any).topic || null;
      content = (data as any).content || "";
      break;
    default:
      fromWorkerId = (data as any).workerId || (data as any).fromWorkerId || "";
      topic = event;
      content = JSON.stringify(data);
  }

  try {
    const message: AgentBusMessage = {
      id: `bus_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      event_type: event,
      from_worker_id: fromWorkerId,
      to_worker_id: toWorkerId,
      topic,
      content,
      metadata: metadata ? JSON.stringify(metadata) : null,
      created_at: Date.now(),
      read: false,
    };
    messageCache.push(message);
    void persistMessageDoc(message);
  } catch (err) {
    log.warn(`Failed to persist message (non-critical): ${(err as Error).message}`);
  }
}

async function persistMessageDoc(message: AgentBusMessage): Promise<void> {
  await (await col<AgentBusMessageDoc>("agentBusMessages")).put(message.id, message);
}

/**
 * Obtiene mensajes no leídos para un worker específico
 */
export function getUnreadMessagesForWorker(workerId: string, limit: number = 50): AgentBusMessage[] {
  try {
    const messages = messageCache
      .filter((message) => !message.read)
      .filter((message) => message.to_worker_id === workerId || message.to_worker_id === "")
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit);

    // Marcar como leídos
    for (const message of messages) {
      message.read = true;
      void persistMessageDoc(message);
    }

    return messages;
  } catch (err) {
    log.error(`Failed to get unread messages: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Obtiene el historial de mensajes de un proyecto
 */
export function getProjectMessageHistory(projectId: string, limit: number = 100): AgentBusMessage[] {
  try {
    return messageCache
      .filter((message) => message.content.includes(projectId) || (message.metadata ?? "").includes(projectId))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
  } catch (err) {
    log.error(`Failed to get project message history: ${(err as Error).message}`);
    return [];
  }
}

// ─── Agent Bus Implementation ────────────────────────────────────────────────

class AgentBusImpl {
  private emitter = new EventEmitter();
  private logPrefix = "[agent-bus]";

  /**
   * Publica un evento en el bus
   */
  publish<K extends AgentBusEventKey>(event: K, data: AgentBusEventMap[K], metadata?: Record<string, unknown>): void {
    const enrichedData = {
      ...data,
      _eventId: crypto.randomUUID(),
      _timestamp: Date.now(),
      _event: event,
    } as AgentBusEventMap[K] & { _eventId: string; _timestamp: number; _event: string };

    // Emitir evento en memoria
    this.emitter.emit(event, enrichedData);

    // Persistir en BD
    persistMessage(event, enrichedData, metadata);

    log.info(`${this.logPrefix} published: ${event}`, { 
      event, 
      fromWorkerId: (data as any).workerId || (data as any).fromWorkerId,
      toWorkerId: (data as any).toWorkerId 
    });
  }

  /**
   * Se suscribe a un tipo de evento
   */
  subscribe<K extends AgentBusEventKey>(
    event: K, 
    handler: AgentBusEventHandler<K>
  ): () => void {
    this.emitter.on(event, handler);
    log.debug(`${this.logPrefix} subscribed to: ${event}`);
    
    return () => this.unsubscribe(event, handler);
  }

  /**
   * Se suscribe una vez a un evento
   */
  subscribeOnce<K extends AgentBusEventKey>(
    event: K, 
    handler: AgentBusEventHandler<K>
  ): void {
    this.emitter.once(event, handler);
  }

  /**
   * Cancela suscripción
   */
  unsubscribe<K extends AgentBusEventKey>(
    event: K, 
    handler: AgentBusEventHandler<K>
  ): void {
    this.emitter.off(event, handler);
  }

  /**
   * Elimina todos los listeners
   */
  removeAllListeners<K extends AgentBusEventKey>(event?: K): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  /**
   * Obtiene cantidad de listeners para un evento
   */
  listenerCount<K extends AgentBusEventKey>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  /**
   * Publica un mensaje personalizado de worker a worker
   */
  sendMessage(
    fromWorkerId: string,
    fromWorkerName: string,
    content: string,
    options?: { toWorkerId?: string; topic?: string }
  ): void {
    this.publish("message:custom", {
      fromWorkerId,
      fromWorkerName,
      toWorkerId: options?.toWorkerId,
      topic: options?.topic || "general",
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * Notifica que una tarea comenzó
   */
  notifyTaskStarted(
    workerId: string,
    workerName: string,
    taskId: number,
    taskName: string,
    projectId: string
  ): void {
    this.publish("worker:task_started", {
      workerId,
      workerName,
      taskId,
      taskName,
      projectId,
      timestamp: Date.now(),
    });
  }

  /**
   * Notifica que una tarea completó
   */
  notifyTaskCompleted(
    workerId: string,
    workerName: string,
    taskId: number,
    taskName: string,
    projectId: string,
    result: string
  ): void {
    this.publish("worker:task_completed", {
      workerId,
      workerName,
      taskId,
      taskName,
      projectId,
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Notifica que una tarea falló
   */
  notifyTaskFailed(
    workerId: string,
    workerName: string,
    taskId: number,
    taskName: string,
    projectId: string,
    error: string
  ): void {
    this.publish("worker:task_failed", {
      workerId,
      workerName,
      taskId,
      taskName,
      projectId,
      error,
      timestamp: Date.now(),
    });
  }

  /**
   * Solicita ayuda a otros workers
   */
  requestHelp(
    fromWorkerId: string,
    fromWorkerName: string,
    taskId: number,
    request: string,
    requiredSkill?: string
  ): void {
    this.publish("worker:help_request", {
      fromWorkerId,
      fromWorkerName,
      taskId,
      request,
      requiredSkill,
      timestamp: Date.now(),
    });
  }

  /**
   * Responde a una solicitud de ayuda
   */
  respondToHelp(
    toWorkerId: string,
    fromWorkerId: string,
    fromWorkerName: string,
    taskId: number,
    response: string
  ): void {
    this.publish("worker:help_response", {
      toWorkerId,
      fromWorkerId,
      fromWorkerName,
      taskId,
      response,
      timestamp: Date.now(),
    });
  }
}

// Singleton
export const agentBus = new AgentBusImpl();

export type AgentBus = typeof agentBus;
