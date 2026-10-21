/**
 * Lo que dejó una corrida: lo que costó, cuántos pasos y herramientas gastó, y si el trabajo
 * acabó en el directorio del proyecto.
 *
 * Las mismas cifras tienen que salir de los dos sitios desde donde se mide una corrida —el
 * script del benchmark (desde el código) y el comando `hivecode run` (dentro del binario
 * compilado)— o la comparación mediría con dos yardsticks distintos. Por eso la recolección
 * vive aquí y los dos la llaman.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { col } from "@johpaz/hivecode-core/storage/hive"

export interface RunReport {
  minutes: number
  /** El trabajo terminó integrado en el proyecto: sin worktrees colgando y con archivos propios. */
  integrated: boolean
  /** El proyecto quedó como un proyecto Bun (package.json presente). */
  hasPackageJson: boolean
  leftoverWorktrees: number
  runs: {
    total: number
    byAgent: Record<string, number>
    blocked: number
    blockers: Record<string, number>
    revisions: number
    maxConcurrentWorkers: number
  }
  tokens: { input: number; output: number }
  costUsd: number
  workerMinutes: { total: number; revisions: number }
  swarm: {
    instancesUsed: string[]
    mergesOk: number
    mergeConflicts: number
    dependencyBlocks: number
    waitFor: number
    shellSleepPolling: number
    maxConcurrentTools: number
    toolCalls: number
    steps: number
    /** Turnos por agente: dice si los pasos son de BEE, del builder o de un verificador. */
    stepsByAgent: Record<string, number>
    toolCallsPerStep: number
  }
  delegations: { delegate: number; revise: number }
  modelOddities: { markupDropped: number; emptyResponses: number }
}

export interface ReportOptions {
  /** Directorio del proyecto donde corrió la tarea. */
  project: string
  /** Inicio de la corrida (ms). Sólo se cuenta lo que pasó después. */
  startedAt: number
  /** Archivo con las respuestas crudas del modelo (HIVE_LLM_RAW_LOG), si lo hubo. */
  rawLogPath?: string
  /** Correr las pruebas del proyecto. Necesita un `bun` en el PATH: el binario no lo tiene. */
  runProjectTests?: boolean
}

/** Los tiempos vienen en segundos o en milisegundos según el que escribió la fila. */
const ms = (t: number) => (t < 1e12 ? t * 1000 : t)
const sum = (items: any[], f: (r: any) => number) => items.reduce((s, r) => s + f(r), 0)
const isRevision = (r: any) => String(r.objective).startsWith("Revisión de una tarea")

/** Conteo de trabajo simultáneo: cada run abre y cierra su turno. */
function peakConcurrency(events: [number, number][]): number {
  let active = 0
  let peak = 0
  for (const [, delta] of events.sort((a, b) => a[0] - b[0])) {
    active += delta
    peak = Math.max(peak, active)
  }
  return peak
}

export async function collectRunReport(options: ReportOptions): Promise<RunReport> {
  const { project, startedAt } = options
  const finishedAt = Date.now()

  const runs = (await (await col<any>("agentRuns")).scan()).map(e => e.doc).filter(r => ms(r.created_at) >= startedAt - 1000)
  const tools = (await (await col<any>("toolRuns")).scan()).map(e => e.doc).filter(t => ms(t.started_at) >= startedAt - 1000)
  const workers = runs.filter(r => r.kind === "worker")
  const dur = (r: any) => (ms(r.completed_at ?? r.updated_at) - ms(r.created_at)) / 1000

  const blockers: Record<string, number> = {}
  for (const r of runs.filter(r => r.status === "blocked")) blockers[String(r.blocker)] = (blockers[String(r.blocker)] ?? 0) + 1

  const raw = options.rawLogPath && existsSync(options.rawLogPath)
    ? readFileSync(options.rawLogPath, "utf-8").trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    : []

  let leftoverWorktrees = 0
  try {
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: project, stdio: "pipe" }).toString()
    leftoverWorktrees = list.split("\n").filter(l => l.startsWith("worktree ")).length - 1
  } catch { /* sin repositorio: no hay worktrees que contar */ }

  const delegationResults = tools.filter(t => t.tool_name === "task_delegate" || t.tool_name === "task_revise").map(t => String(t.result_json ?? ""))
  const toolEvents = tools.flatMap(t => [[ms(t.started_at), 1], [ms(t.completed_at ?? t.started_at), -1]] as const) as [number, number][]
  const workerEvents = workers.flatMap(r => [[ms(r.created_at), 1], [ms(r.completed_at ?? r.updated_at), -1]] as const) as [number, number][]
  // Lo que el proyecto tiene de sí mismo: sin eso, el trabajo se quedó en un worktree.
  const projectFiles = existsSync(project) ? readdirSync(project).filter(f => f !== ".git") : []

  return {
    minutes: +((finishedAt - startedAt) / 60000).toFixed(2),
    integrated: leftoverWorktrees === 0 && projectFiles.length > 0,
    hasPackageJson: existsSync(`${project}/package.json`),
    leftoverWorktrees,
    runs: {
      total: runs.length,
      byAgent: Object.fromEntries([...new Set(runs.map(r => r.agent_id))].map(a => [a, runs.filter(r => r.agent_id === a).length])),
      blocked: runs.filter(r => r.status === "blocked").length,
      blockers,
      revisions: workers.filter(isRevision).length,
      maxConcurrentWorkers: peakConcurrency(workerEvents),
    },
    tokens: { input: sum(runs, r => r.input_tokens), output: sum(runs, r => r.output_tokens) },
    costUsd: +sum(runs, r => r.cost_usd ?? 0).toFixed(4),
    workerMinutes: {
      total: +(sum(workers, dur) / 60).toFixed(1),
      revisions: +(sum(workers.filter(isRevision), dur) / 60).toFixed(1),
    },
    swarm: {
      instancesUsed: [...new Set(runs.filter(r => /#\d+$/.test(String(r.agent_id))).map(r => r.agent_id))],
      mergesOk: delegationResults.filter(r => /"merge":"(integrated|noop)"/.test(r)).length,
      mergeConflicts: delegationResults.filter(r => /"merge":"(conflict|failed)"/.test(r)).length,
      dependencyBlocks: delegationResults.filter(r => r.includes("blocked_by")).length,
      waitFor: tools.filter(t => t.tool_name === "wait_for").length,
      shellSleepPolling: tools.filter(t => t.tool_name === "shell_executor" && /\bsleep\b/.test(String(t.args_json ?? ""))).length,
      maxConcurrentTools: peakConcurrency(toolEvents),
      toolCalls: tools.length,
      steps: sum(runs, r => r.turn ?? 0),
      // Turnos por agente: dice si los pasos son de BEE, del builder o de un verificador.
      stepsByAgent: Object.fromEntries([...new Set(runs.map(r => r.agent_id))].map(a => [a, sum(runs.filter(r => r.agent_id === a), r => r.turn ?? 0)])),
      toolCallsPerStep: +(tools.length / Math.max(1, sum(runs, r => r.turn ?? 0))).toFixed(2),
    },
    delegations: {
      delegate: tools.filter(t => t.tool_name === "task_delegate").length,
      revise: tools.filter(t => t.tool_name === "task_revise").length,
    },
    modelOddities: {
      markupDropped: raw.filter(r => r.parsed === 0 && !r.empty).length,
      emptyResponses: raw.filter(r => r.empty).length,
    },
  }
}
