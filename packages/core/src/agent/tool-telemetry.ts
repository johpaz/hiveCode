/**
 * Telemetría de herramientas para la TUI.
 *
 * `broadcastToolStart` / `broadcastToolEnd` ya existían en
 * `gateway/task-streaming.ts` con un `BeeState` que clasifica cada tool
 * (`fs_read→reading`, `fs_write→writing`, `shell_executor→executing`), pero
 * **no tenían un solo caller**: el enjambre hacía sus llamadas a ciegas y la
 * TUI solo recibía `current_action: "ejecutando <phase>"`, un texto libre que no
 * decía qué herramienta corría ni cuánto iba a tardar.
 *
 * Este módulo es el único emisor. Dos reglas:
 *
 * 1. **Nunca bloquear la ejecución.** Una tool que tarda 4 s no puede esperar a
 *    que la TUI lea un evento. Las emisiones son `void`, sin `await`.
 * 2. **Nunca enviar payloads crudos.** El TUI tiene columnas de 20-30 celdas;
 *    un `fs_read` de 400 KB de JSON no se renderiza, se trunca.
 */
import { eventBus } from "../events/event-bus"

/** Tope de caracteres de un resumen. Cabe en una columna de la TUI. */
const SUMMARY_MAX = 120

/**
 * Colapsa cualquier valor a una sola línea y le corta.
 *
 * Los argumentos de una tool vienen como string JSON o como objeto. Un objeto
 * anidado expandido no aporta nada en una columna, así que solo se conserva el
 * nivel superior.
 */
export function summarizeArgs(value: unknown): string {
  if (value == null) return ""
  let text: string
  if (typeof value === "string") {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      return "[no serializable]"
    }
  }
  text = text.replace(/\s+/g, " ").trim()
  if (text.length <= SUMMARY_MAX) return text
  return text.slice(0, SUMMARY_MAX - 1) + "…"
}

/**
 * Estado legible de un agente, reusando la clasificación que ya existía en
 * `task-streaming.ts`. La TUI lo muestra como glifo junto al nombre de la tool.
 */
export type BeeState =
  | "thinking" | "searching" | "reading" | "writing"
  | "executing" | "done" | "error"

/** Mismo mapeo que `toolToBeeState()` en gateway/task-streaming.ts. */
export function toolToBeeState(tool: string): BeeState {
  if (tool.startsWith("fs_read") || tool === "parse_ast" || tool === "find_imports") return "reading"
  if (tool.startsWith("fs_write") || tool.startsWith("fs_edit") || tool.startsWith("fs_delete")) return "writing"
  if (tool === "shell_executor" || tool.startsWith("code_build") || tool.startsWith("code_test")) return "executing"
  if (tool.startsWith("search_knowledge") || tool.includes("_search") || tool === "fs_glob") return "searching"
  if (tool.startsWith("web_") || tool.startsWith("browser_")) return "searching"
  return "thinking"
}

let callSequence = 0

/**
 * Anuncia el inicio de una llamada. Sin `await` a propósito: la telemetría no
 * puede ser un cuello de botella para el trabajo real.
 */
export function emitToolCall(input: {
  agentId: string
  tool: string
  callId?: string
  argsSummary?: string
  taskId?: string
}): void {
  try {
    eventBus.emit("tool:call", {
      agentId: input.agentId,
      tool: input.tool,
      callId: input.callId ?? `c${++callSequence}`,
      argsSummary: (input.argsSummary ?? "").slice(0, SUMMARY_MAX),
      beeState: toolToBeeState(input.tool),
      taskId: input.taskId ?? null,
      at: Date.now(),
    })
  } catch {
    // Telemetría nunca es una dependencia dura.
  }
}

/** Cierra una llamada. Siempre acompaña a un `emitToolCall` con el mismo `callId`. */
export function emitToolDone(input: {
  agentId: string
  tool: string
  callId?: string
  ok: boolean
  durationMs: number
  resultSummary?: string
  taskId?: string
}): void {
  try {
    eventBus.emit("tool:done", {
      agentId: input.agentId,
      tool: input.tool,
      callId: input.callId ?? `c${++callSequence}`,
      ok: input.ok,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      resultSummary: (input.resultSummary ?? "").slice(0, SUMMARY_MAX),
      taskId: input.taskId ?? null,
      at: Date.now(),
    })
  } catch {
    // Telemetría nunca es una dependencia dura.
  }
}

/**
 * La carga efectiva de un agente en un turno.
 *
 * No es el perfil declarado. JEV poda el conjunto de herramientas y
 * `search_knowledge` lo amplía, así que lo que el agente tiene delante cambia en
 * cada turno aunque no haya descubierto nada nuevo. La ficha del especialista
 * muestra esto para no anunciar herramientas que ya no tiene.
 */
export function emitLoadout(input: {
  agentId: string
  tools: string[]
  skills: string[]
  origen: "perfil" | "jev_pruned"
  minimal: string[]
}): void {
  try {
    eventBus.emit("agent:loadout", {
      agentId: input.agentId,
      tools: input.tools.slice(0, 80),
      skills: input.skills.slice(0, 30),
      origen: input.origen,
      minimal: input.minimal.slice(0, 30),
      at: Date.now(),
    })
  } catch {
    // Telemetría nunca es una dependencia dura.
  }
}

/**
 * Un agente que no puede seguir porque depende de otro.
 *
 * `razon` es una etiqueta corta y legible: `"jev_secuencial"` cuando Jev decidió
 * que el lote no era seguro en paralelo, `"subagente"` mientras espera un
 * `spawn_agent`, `"dependencia"` cuando la fase depende de otra.
 */
export function emitWaiting(input: {
  agentId: string
  waitingFor?: string[]
  reason: string
  taskId?: string
}): void {
  try {
    eventBus.emit("agent:waiting", {
      agentId: input.agentId,
      waitingFor: (input.waitingFor ?? []).slice(0, 8),
      reason: input.reason.slice(0, SUMMARY_MAX),
      taskId: input.taskId ?? null,
      at: Date.now(),
    })
  } catch {
    // Telemetría nunca es una dependencia dura.
  }
}