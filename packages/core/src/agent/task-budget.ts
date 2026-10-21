/**
 * Presupuesto de tokens de una tarea del harness, compartido por BEE y por todos los workers
 * que lance: cada run suma lo que gasta y se corta cuando la tarea entera lo agota.
 *
 * El tope por agente (`max_input_tokens` en `AgentDoc`) no sirve para esto: la tarea gasta en
 * varios runs a la vez, y un tope por run deja pasar 9 runs de 1,5 M. Aquí la unidad es la
 * tarea, identificada por el `codeTaskId` que ya viaja de BEE a cada worker.
 *
 * Vive en memoria del proceso: los runs de una tarea corren en el proceso que la lanzó.
 * Ver `docs/rutas-por-costo.md` §6.
 */

export interface TaskBudgetLimit {
  /** Tokens de entrada acumulados entre todos los turnos de la tarea. 0 = sin límite. */
  maxInputTokens: number
  /** Tokens de salida acumulados. 0 = sin límite. */
  maxOutputTokens: number
  /**
   * Parte del presupuesto (0–0,9) que los workers no pueden tocar. Ellos se detienen en `límite × (1 − reserva)`;
   * el coordinador sigue hasta el límite. Sin reserva, cinco scouts leyendo en paralelo se gastaban todo el tope
   * y BEE moría antes de delegar en el planner: se entregaban hallazgos sueltos y no el plan que se pidió.
   */
  reserveShare?: number
}

interface TaskBudgetState {
  limit: TaskBudgetLimit
  inputTokens: number
  outputTokens: number
}

const budgets = new Map<string, TaskBudgetState>()

/** Empieza (o reinicia) el presupuesto de una tarea. */
export function setTaskBudget(taskId: string, limit: TaskBudgetLimit): void {
  budgets.set(taskId, { limit, inputTokens: 0, outputTokens: 0 })
}

/** Termina el presupuesto y devuelve lo gastado. Idempotente. */
export function clearTaskBudget(taskId: string): { inputTokens: number; outputTokens: number } | undefined {
  const state = budgets.get(taskId)
  budgets.delete(taskId)
  return state && { inputTokens: state.inputTokens, outputTokens: state.outputTokens }
}

/** Suma el gasto de un turno. No hace nada si la tarea no tiene presupuesto. */
export function recordTaskUsage(taskId: string | undefined, inputTokens: number, outputTokens: number): void {
  const state = taskId ? budgets.get(taskId) : undefined
  if (!state) return
  state.inputTokens += inputTokens || 0
  state.outputTokens += outputTokens || 0
}

/**
 * El blocker (`task_input_tokens:1500000`) si la tarea ya agotó su presupuesto, y `undefined`
 * si no lo agotó o no tiene uno.
 */
export function taskBudgetBlocker(taskId: string | undefined, role: "coordinator" | "worker" = "coordinator"): string | undefined {
  const state = taskId ? budgets.get(taskId) : undefined
  if (!state) return undefined
  const { limit } = state
  // A worker stops short of the cap by the reserve; the coordinator has it all.
  const share = role === "worker" ? 1 - Math.min(0.9, Math.max(0, limit.reserveShare ?? 0)) : 1
  const maxInput = Math.round(limit.maxInputTokens * share)
  const maxOutput = Math.round(limit.maxOutputTokens * share)
  if (limit.maxInputTokens > 0 && state.inputTokens >= maxInput) return `task_input_tokens:${maxInput}`
  if (limit.maxOutputTokens > 0 && state.outputTokens >= maxOutput) return `task_output_tokens:${maxOutput}`
  return undefined
}

export function taskBudgetUsage(taskId: string): { inputTokens: number; outputTokens: number } | undefined {
  const state = budgets.get(taskId)
  return state && { inputTokens: state.inputTokens, outputTokens: state.outputTokens }
}
