/**
 * Searches for tools, skills or MCP servers a worker may spend in one run.
 *
 * Each one is a whole model turn that returns a list: `docs/rutas-por-costo.md` records workers that spent
 * their task on `search_knowledge` before writing a line. Searching the project's CODE is not capped: that
 * is the index doing its job. The coordinator is not capped either; it decides what to delegate.
 */
export const MAX_CAPABILITY_SEARCHES = 2

const used = new Map<string, number>()
/** Runs remembered at most; a run that never reports its end must not grow the map without bound. */
const MAX_TRACKED_RUNS = 500

/** A `search_knowledge` that looks for capabilities (not code). */
export function isCapabilitySearch(toolName: string, args: unknown): boolean {
  if (toolName !== "search_knowledge") return false
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args
    return (parsed as { type?: unknown } | null)?.type !== "code"
  } catch { return true }
}

/** Counts one capability search for the run; false when the run is out of them. */
export function chargeCapabilitySearch(runId: string): boolean {
  const count = used.get(runId) ?? 0
  if (count >= MAX_CAPABILITY_SEARCHES) return false
  if (used.size >= MAX_TRACKED_RUNS) used.delete(used.keys().next().value as string)
  used.set(runId, count + 1)
  return true
}

export function endDiscovery(runId: string): void { used.delete(runId) }

export const CAPABILITY_SEARCH_LIMIT_MESSAGE =
  `Ya hiciste ${MAX_CAPABILITY_SEARCHES} búsquedas de herramientas o skills en esta tarea y cada una cuesta un turno. ` +
  `Trabaja con lo que tienes: tus herramientas ya están en contexto. Para entender el código usa search_knowledge con type="code", ` +
  `outline o find_symbol. Si de verdad te falta una capacidad, dilo en tu handoff para que BEE la resuelva.`
