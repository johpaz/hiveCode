/**
 * Delegation to workers, Hive style: a bounded task, verifiable acceptance
 * criteria, and evidence back to the coordinator.
 *
 * Hive continues delegated jobs on a durable gateway queue and wakes the
 * coordinator for a fan-in turn. hiveCode runs in one process, so the same
 * shape happens inside the turn: sibling `task_delegate` calls run concurrently
 * (the loop decides that with `jevWantsParallel`), each returns its evidence,
 * and the coordinator is the fan-in — it judges, or sends a task back with
 * `task_revise` on the worker's own thread.
 */
import { loadConfig } from "../config/loader"
import { logger } from "../utils/logger"
import type { Tool } from "../tools/types"

const log = logger.child("delegation")

export interface AcceptanceCriterion {
  id: string
  description: string
  /** A tool that decides the criterion without an LLM. It receives `{ goal }` and returns `{ met, reason }`. */
  checkTool?: string
}

export interface AcceptanceResult {
  id: string
  description: string
  /** `null`: no deterministic check exists, so the coordinator judges it from the evidence. */
  met: boolean | null
  evidence: string
}

export const DEFAULT_ACCEPTANCE: AcceptanceCriterion[] = [
  { id: "objective", description: "The task is done as described and the handoff names the evidence." },
]

export function parseAcceptance(raw: unknown, fallbackDescription: string): AcceptanceCriterion[] {
  if (Array.isArray(raw)) {
    const parsed = raw.flatMap((item): AcceptanceCriterion[] => {
      if (!item || typeof item !== "object") return []
      const { id, description, checkTool } = item as Record<string, unknown>
      if (typeof description !== "string" || !description.trim()) return []
      return [{
        id: typeof id === "string" && id ? id : `c${raw.indexOf(item) + 1}`,
        description,
        ...(typeof checkTool === "string" && checkTool ? { checkTool } : {}),
      }]
    })
    if (parsed.length > 0) return parsed
  }
  return [{ id: "objective", description: fallbackDescription }]
}

/** What the worker is told: the task, then the bar its delivery will be held to. */
export function buildWorkerBrief(taskDescription: string, acceptance: AcceptanceCriterion[]): string {
  const criteria = acceptance.map((c) => `- [${c.id}] ${c.description}`).join("\n")
  return [
    taskDescription,
    "",
    "Criterios de aceptación (tu entrega se juzga contra ellos; da evidencia por cada uno):",
    criteria,
    "",
    "Termina con un handoff: qué hiciste, artefactos (rutas), evidencia por criterio, riesgos.",
    "Si te falta información, dilo en el handoff en vez de adivinar.",
  ].join("\n")
}

/**
 * Interpret a check tool's result strictly: an object with a boolean `met`,
 * a bare boolean, or a JSON string with `met` — anything else is not met.
 */
export function interpretCheckResult(raw: unknown): { met: boolean; reason: string } {
  if (typeof raw === "boolean") return { met: raw, reason: `Check tool returned ${raw}` }
  if (raw && typeof raw === "object" && "met" in raw) {
    const obj = raw as { met: unknown; reason?: unknown }
    return { met: obj.met === true, reason: typeof obj.reason === "string" ? obj.reason : `Check tool met=${obj.met === true}` }
  }
  if (typeof raw === "string") {
    const text = raw.trim()
    if (text === "true" || text === "false") return { met: text === "true", reason: `Check tool returned "${text}"` }
    try {
      return interpretCheckResult(JSON.parse(text))
    } catch { /* not JSON */ }
  }
  return { met: false, reason: "Check tool result had no interpretable met/true signal" }
}

async function runCheckTool(checkTool: string, goal: string, tools: Tool[]): Promise<{ met: boolean; reason: string } | null> {
  const tool = tools.find((candidate) => candidate.name === checkTool)
  if (!tool) {
    log.warn(`Check tool "${checkTool}" is not in the registry; the coordinator judges that criterion`)
    return null
  }
  try {
    return interpretCheckResult(await tool.execute({ goal }, {}))
  } catch (error) {
    return { met: false, reason: `Check tool failed: ${(error as Error).message}` }
  }
}

/**
 * Deterministic part of the verdict. Criteria with a working `checkTool` get a
 * hard yes/no; the rest come back with `met: null` and the worker's handoff as
 * evidence, for the coordinator to judge.
 */
export async function checkAcceptance(
  acceptance: AcceptanceCriterion[],
  handoff: string,
  tools?: Tool[],
): Promise<AcceptanceResult[]> {
  let registry = tools
  const results: AcceptanceResult[] = []
  for (const criterion of acceptance) {
    if (criterion.checkTool) {
      registry ??= (await import("../tools/index")).createAllTools(loadConfig())
      const verdict = await runCheckTool(criterion.checkTool, criterion.description, registry)
      if (verdict) {
        results.push({ id: criterion.id, description: criterion.description, met: verdict.met, evidence: verdict.reason })
        continue
      }
    }
    results.push({ id: criterion.id, description: criterion.description, met: null, evidence: handoff.slice(0, 1200) })
  }
  return results
}

/** `met` only when every criterion is hard-confirmed; `false` as soon as one fails; `null` while some await judgement. */
export function summarizeAcceptance(results: AcceptanceResult[]): boolean | null {
  if (results.some((r) => r.met === false)) return false
  return results.every((r) => r.met === true) ? true : null
}

/** Deterministic thread of a delegated task, so `task_revise` resumes the worker with its own context. */
export function delegationThreadId(taskId: string, workerId: string): string {
  return `task-${taskId}-${workerId}`
}
