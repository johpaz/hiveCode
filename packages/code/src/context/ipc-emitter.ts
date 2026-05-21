// Interfaz mínima de emisión IPC que usan Blackboard y ConflictDetector.
// En producción se inyecta el emisor real (Unix socket, broadcast, etc.).
// En tests se puede pasar un mock o undefined.

export interface IpcEmitter {
  emit(event: string, payload: unknown): void
}

/** Adaptador para broadcastNarrative y similares del gateway actual */
export function makeGatewayEmitter(taskId: string | undefined): IpcEmitter {
  return {
    emit(event: string, payload: unknown): void {
      if (!taskId) return
      // El gateway actual usa broadcastNarrative para enviar al TUI.
      // Cuando IPC Unix socket esté listo (Fase 6) este adaptador
      // será reemplazado por el emisor de socket con envelope + prioridad.
      try {
        const { broadcastNarrative } = require("@johpaz/hivecode-core/gateway/task-streaming") as any
        broadcastNarrative(taskId, { type: event, payload })
      } catch {
        // Silencioso si el gateway no está activo (tests, CLI sin TUI)
      }
    },
  }
}
