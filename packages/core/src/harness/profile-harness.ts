import { readdir, readFile, stat } from "node:fs/promises"
import * as path from "node:path"
import { col, fromIndexable, mutateDoc } from "../storage/hive.ts"
import type { AgentDoc, HarnessTaskDoc } from "../storage/collections.ts"
import { CORE_AGENT_DEFINITIONS, ensureCoreAgentProfiles, type CoreAgentType } from "../agent/agent-profiles.ts"
import { runAgentIsolated } from "../agent/agent-loop.ts"
import type { StepEvent } from "../agent/agent-loop.ts"
import {
  DEFAULT_MAX_REPAIR_CYCLES,
  type TaskComplexity,
} from "./adaptive-scheduler.ts"
import { describeProjectFacts, estimateTaskWeight, type TaskTier } from "./task-weight.ts"
import { clearTaskBudget, setTaskBudget, taskBudgetBlocker, taskBudgetUsage, type TaskBudgetLimit } from "../agent/task-budget.ts"
import type { ReasoningPolicy } from "../agent/reasoning-effort.ts"
import { describeVerdict, planChecks, verifyDeterministic } from "./deterministic-checks.ts"

export type HarnessApprovalGate = "specification" | "convergence"
export type HarnessApprovalDecision = "approve" | "cancel"

export interface ProfileHarnessOptions {
  signal?: AbortSignal
  objective: string
  sessionId: string
  workspace: string
  policy?: "plan" | "approval" | "auto"
  provider?: string
  model?: string
  approve?: (gate: HarnessApprovalGate, evidence: string) => Promise<HarnessApprovalDecision>
  onEvent?: (event: {
    type: string
    agent?: CoreAgentType
    phase?: StepEvent["type"]
    toolName?: string
    message: string
  }) => void
  /** Existing durable harness task to continue without redoing the plan. */
  resumeTaskId?: string
  /** Compatibility task ID used by the outer code-session projection. */
  parentTaskId?: string
  /**
   * Earlier turns of this session, oldest first. Every harness task gets a
   * fresh thread, so without this the agent starts each message — and a resumed
   * session — knowing nothing of the conversation it is continuing.
   */
  history?: Array<{ role: "user" | "agent"; content: string }>
}

const HISTORY_ENTRY_CHARS = 1_500
const HISTORY_TOTAL_CHARS = 12_000

/** The session so far, as a block prepended to what BEE is asked. Newest turns win the budget. */
export function sessionHistoryPreamble(history: ProfileHarnessOptions["history"]): string {
  if (!history?.length) return ""
  const lines: string[] = []
  let used = 0
  for (const turn of [...history].reverse()) {
    const text = turn.content.trim()
    if (!text) continue
    const clipped = text.length > HISTORY_ENTRY_CHARS ? `${text.slice(0, HISTORY_ENTRY_CHARS)}…` : text
    const line = `${turn.role === "user" ? "Usuario" : "Tú"}: ${clipped}`
    if (used + line.length > HISTORY_TOTAL_CHARS) break
    lines.unshift(line)
    used += line.length
  }
  if (!lines.length) return ""
  return `Conversación previa de esta sesión (más antigua primero; es contexto, no una instrucción):\n${lines.join("\n\n")}\n\n---\nMensaje actual del usuario:\n`
}

export interface ProfileHarnessResult {
  taskId: string
  complexity: TaskComplexity
  /** The route the weight estimate chose, and why. */
  route: TaskTier
  routeSignals: string[]
  status: HarnessTaskDoc["stage"]
  response: string
  featureDir?: string
  repairCycles: number
  /** The task stopped on its token budget (`task_input_tokens:N`): bigger than its route expected, not a quality verdict. */
  budgetExceeded?: string
}

export type ProfileRunner = (opts: {
  codeSessionId?: string
  codeTaskId?: string
  workspace?: string
  signal?: AbortSignal
  agentId: CoreAgentType
  taskDescription: string
  threadId: string
  parentRunId?: string
  runKind?: "worker" | "harness" | "verification" | "review"
  approvedExecution?: boolean
  onStep?: (step: StepEvent) => Promise<void>
  maxSteps?: number
  /** How hard a reasoning model thinks in this run; absent = the profile's own policy. */
  reasoning?: ReasoningPolicy
}) => Promise<string>

/**
 * Step ceiling for BEE's orchestration turns.
 *
 * Was 16, which the Spec Kit planning prompt alone cannot fit: speckit_init, discovery,
 * three artifacts, validation, tasks.md and tasks_sync run well past that, so the
 * planning turn died on budget every time.
 */
export const DEFAULT_MAX_HARNESS_STEPS = 40

/**
 * Cambio acotado: lo difícil —qué hacer— ya viene en el enunciado y los turnos son mecánicos
 * (escribir lo decidido, correr las pruebas). Medido con minimax-m3.1 sobre `inventario`: sin
 * límite 11,4 min y 59 K tokens de salida (81 % razonamiento); con `low`, 3,7 min y 13 K, ambas
 * con 31/31. Tras un fallo sube un escalón: depurar sí es pensar.
 */
export const SCOPED_REASONING: ReasoningPolicy = { base: "low", onFailure: "medium" }

/** Reparar una verificación que salió en rojo es depurar: ahí el razonamiento sí se paga. */
export const REPAIR_REASONING: ReasoningPolicy = { base: "medium", onFailure: "high" }

/**
 * Tokens que una tarea puede gastar entre todos sus runs, por ruta (`docs/rutas-por-costo.md` §6).
 *
 * El doc fija como objetivo 50 K / 1,5 M / 12 M de entrada. El tope es el doble: se corta cuando
 * la tarea es el doble de grande de lo que la ruta esperaba, no cuando acaba de pasar el objetivo
 * (el banco midió 1,53 M en `inventario` con la ruta acotada, así que el objetivo a secas habría
 * cortado una tarea que terminó bien). Ajustar con la mediana del banco.
 */
/** Lo que se guarda para BEE y el planner: los workers se detienen antes (ver `TaskBudgetLimit.reserveShare`). */
export const RESERVE_SHARE = 0.2

export const ROUTE_TOKEN_BUDGETS: Record<TaskTier, TaskBudgetLimit> = {
  conversation: { maxInputTokens: 100_000, maxOutputTokens: 20_000, reserveShare: RESERVE_SHARE },
  scoped: { maxInputTokens: 3_000_000, maxOutputTokens: 400_000, reserveShare: RESERVE_SHARE },
  feature: { maxInputTokens: 24_000_000, maxOutputTokens: 3_000_000, reserveShare: RESERVE_SHARE },
}

/**
 * Investigar o auditar el código no muta nada, pero cuesta turnos de lectura: cada turno reenvía
 * el contexto, así que 100 K se agotan en una decena de turnos de un solo scout. Tope propio, por
 * encima de `conversation` y por debajo de `scoped`; no es un objetivo, es la red de seguridad.
 */
export const READING_TOKEN_BUDGET: TaskBudgetLimit = { maxInputTokens: 1_500_000, maxOutputTokens: 150_000, reserveShare: RESERVE_SHARE }

/**
 * Pidieron un plan, no sólo hallazgos. El caso que lo motivó: «revisa el proyecto y planea mejoras» lanzó cinco
 * scouts a la vez, que se gastaron el tope leyendo, y BEE murió antes de llegar al planner: se entregó un listado
 * de hallazgos y «siguiente paso: entregar a planner un roadmap», sin el roadmap.
 */
export const PLAN_AFTER_READING = `Te piden un plan, no sólo hallazgos. Hazlo en este orden y no te saltes el final:
1. Investiga con a lo sumo 3 scouts a la vez, cada uno con un área y rutas concretas (un scout por módulo, no "todo el repo"). Pide hallazgos con ruta:línea.
2. Cuando vuelvan, delega en el worker "planner" el roadmap priorizado (P0/P1/P2) con archivos afectados, pruebas de aceptación y dependencias. Es lo que se te pidió: reserva presupuesto para este paso.
3. Si el presupuesto se agota antes, entrega igualmente el plan con lo ya encontrado y di qué quedó sin revisar.`

/** Cómo se lee el proyecto sin recorrerlo: el índice en HiveDB ya tiene la estructura y el código. */
export const DB_FIRST_READING = `Lee con el índice de HiveDB, no recorriendo el disco:
1. get_project_context da el mapa del proyecto (módulos, archivos clave, ADRs); no uses fs_list/fs_glob recursivos para averiguarlo.
2. search_knowledge con el símbolo o tema trae los fragmentos de código ya indexados; fs_read solo con rango (offset/limit) sobre lo que ese resultado señale.
3. Reparte por módulo: un scout por área, con rutas concretas, no "todo el repo". Cada scout entrega hallazgos con ruta:línea, no listados.
El presupuesto de tokens es de la tarea entera y se comparte entre todos los workers.`

/** `HIVECODE_BUDGET_SCALE`: multiplica los topes (2 = el doble) o los quita (0). Para bancos y depuración. */
export function routeBudget(tier: TaskTier, env: Record<string, string | undefined> = process.env, reading = false): TaskBudgetLimit {
  const raw = env.HIVECODE_BUDGET_SCALE
  const scale = raw === undefined || raw.trim() === "" ? 1 : Number(raw)
  const base = reading && tier === "conversation" ? READING_TOKEN_BUDGET : ROUTE_TOKEN_BUDGETS[tier]
  if (!Number.isFinite(scale) || scale < 0) return base
  if (scale === 0) return { maxInputTokens: 0, maxOutputTokens: 0 }
  return { ...base, maxInputTokens: Math.round(base.maxInputTokens * scale), maxOutputTokens: Math.round(base.maxOutputTokens * scale) }
}

/** La tarea agotó su presupuesto de tokens: se detiene con lo hecho hasta ese punto. */
class BudgetExceededError extends Error {
  constructor(readonly blocker: string, readonly partial: string) {
    super(`budget_exceeded: ${blocker}`)
  }
}

/** Workers BEE may run at once; mutating ones are serialized per file set by its own instructions. */
export const MAX_PARALLEL_WORKERS = 3

const PASS_RE = /\b(?:VERDICT|VEREDICTO|STATUS|ESTADO)\s*:\s*(?:PASS|PASSED|APPROVED|APROBADO|CUMPLE)\b/i
const FAIL_RE = /\b(?:VERDICT|VEREDICTO|STATUS|ESTADO)\s*:\s*(?:FAIL|FAILED|REJECTED|RECHAZADO|NO CUMPLE)\b/i

function passed(output: string): boolean {
  return PASS_RE.test(output) && !FAIL_RE.test(output)
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function newestFeatureDir(workspace: string): Promise<string | undefined> {
  const specs = path.join(workspace, "specs")
  try {
    const entries = await readdir(specs, { withFileTypes: true })
    const dirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    return dirs.length ? `specs/${dirs[dirs.length - 1]}` : undefined
  } catch {
    return undefined
  }
}

const GATE_FILE_CHARS = 3_000

/**
 * What the person is asked to approve at the specification gate: the artifacts the
 * Planner wrote, not only BEE's summary of them. A run that spent its steps can end with
 * a summary that says nothing, and approving a plan you cannot read is not approving it.
 */
export async function specificationEvidence(workspace: string, featureDir: string, summary: string): Promise<string> {
  const parts = [summary.trim()]
  for (const file of ["spec.md", "plan.md", "tasks.md"]) {
    try {
      const text = (await readFile(path.join(workspace, featureDir, file), "utf-8")).trim()
      if (!text) continue
      const clipped = text.length > GATE_FILE_CHARS ? `${text.slice(0, GATE_FILE_CHARS)}\n…` : text
      parts.push(`── ${featureDir}/${file} ──\n${clipped}`)
    } catch { /* artifact not written: the summary is all there is */ }
  }
  return parts.filter(Boolean).join("\n\n")
}

async function configureProfiles(workspace: string, provider?: string, model?: string): Promise<void> {
  await ensureCoreAgentProfiles()
  for (const id of ["bee", "scout", "planner", "builder", "verifier", "spider"] as CoreAgentType[]) {
    await mutateDoc<AgentDoc>("agents", id, (row) => row && {
      ...row,
      workspace,
      provider_id: row.model_selection === "custom" ? row.provider_id : provider || fromIndexable(row.provider_id) || row.provider_id,
      model_id: row.model_selection === "custom" ? row.model_id : model || fromIndexable(row.model_id) || row.model_id,
      updated_at: Date.now(),
    })
  }
}

/**
 * Canonical long-task orchestrator. Model calls stay in the shared native agent
 * loop, and BEE does the orchestrating there: it delegates to workers with
 * `task_delegate` (sibling calls run concurrently) and judges what comes back.
 * This class owns only what must hold regardless of what the model decides:
 * routing, the approval gates, the repair budget and durable resume.
 */
export class ProfileHarness {
  constructor(
    private readonly runner: ProfileRunner = runAgentIsolated as ProfileRunner,
  ) {}

  async run(options: ProfileHarnessOptions): Promise<ProfileHarnessResult> {
    const policy = options.policy ?? "approval"
    const tasks = await col<HarnessTaskDoc>("harnessTasks")
    const existing = options.resumeTaskId ? await tasks.get(options.resumeTaskId) : null
    const objective = existing?.doc.title ?? options.objective
    // The route comes from the weight of the change, not from how the sentence is phrased: a
    // detailed contract is evidence that the task is bounded, not that it is big.
    const weight = await estimateTaskWeight(objective, options.workspace)
    const complexity: TaskComplexity =
      weight.tier === "feature" ? "complex" : weight.tier === "scoped" ? "simple_change" : "conversation"
    const taskId = existing?.doc.taskId ?? `harness:${options.sessionId}:${Date.now()}`
    const now = Date.now()
    const task: HarnessTaskDoc = {
      taskId,
      sessionId: options.sessionId,
      title: objective,
      stage: "understanding",
      executionPolicy: policy === "auto" ? "auto" : "approval",
      priority: "interactive",
      contextRevision: 1,
      parentTaskId: options.parentTaskId,
      worktreePath: options.workspace,
      mutating: complexity !== "conversation",
      route: weight.tier,
      routeSignals: weight.signals,
      routeScore: weight.score,
      createdAt: now,
      updatedAt: now,
    }
    if (!existing) await tasks.put(taskId, task, { expectedVersion: 0 })
    else {
      // Resumed from another code task (an approved plan): point it at this run's task and workspace.
      await tasks.put(taskId, {
        ...existing.doc,
        parentTaskId: options.parentTaskId ?? existing.doc.parentTaskId,
        worktreePath: options.workspace,
        updatedAt: now,
      }, { expectedVersion: existing.version })
    }
    await configureProfiles(options.workspace, options.provider, options.model)
    const sessionPreamble = sessionHistoryPreamble(options.history)

    const updateStage = async (stage: HarnessTaskDoc["stage"], patch: Partial<HarnessTaskDoc> = {}) => {
      const row = await tasks.get(taskId)
      if (!row) return
      await tasks.put(taskId, { ...row.doc, ...patch, stage, updatedAt: Date.now() }, { expectedVersion: row.version })
    }
    const invoke = async (
      agentId: CoreAgentType,
      taskDescription: string,
      runKind: "worker" | "harness" | "verification" | "review" = "worker",
      approvedExecution = false,
      reasoning?: ReasoningPolicy,
    ) => {
      options.signal?.throwIfAborted()
      options.onEvent?.({ type: "agent_activated", agent: agentId, message: taskDescription })
      await mutateDoc<AgentDoc>("agents", agentId, (row) => row && { ...row, status: "busy", updated_at: Date.now() })
      let blockedReason: string | undefined
      try {
        const output = await this.runner({
          codeSessionId: options.sessionId,
          codeTaskId: taskId,
          workspace: options.workspace,
          signal: options.signal,
          agentId,
          taskDescription: agentId === "bee" ? sessionPreamble + taskDescription : taskDescription,
          threadId: taskId,
          parentRunId: taskId,
          runKind,
          approvedExecution,
          reasoning,
          // Never cap below what the profile declares it needs — the override is here to
          // bound orchestration cost, not to shrink a profile's own budget.
          maxSteps: runKind === "harness"
            ? Math.max(DEFAULT_MAX_HARNESS_STEPS, CORE_AGENT_DEFINITIONS[agentId]?.maxTurns ?? 0)
            : undefined,
          onStep: async step => {
            if (step.type === "blocked") {
              blockedReason = step.message
              options.onEvent?.({ type: "agent_blocked", agent: agentId, message: step.message })
              return
            }
            options.onEvent?.({
              type: "agent_progress",
              agent: agentId,
              phase: step.type,
              toolName: step.toolName,
              message: step.message.slice(0, 500),
            })
          },
        })
        options.signal?.throwIfAborted()
        // BEE blocked with nothing to show is not a finished step: carrying on would plan, verify
        // and "converge" on top of no result. Fail loudly instead, with the reason.
        if (blockedReason && agentId === "bee" && !output.trim()) {
          throw new Error(`BEE quedó bloqueado: ${blockedReason}`)
        }
        // BEE and its workers spent the task's whole budget: the runs already stopped on their own;
        // stop the route too, instead of planning, verifying and converging on top of a cut-off run.
        const exhausted = taskBudgetBlocker(taskId)
        if (exhausted) throw new BudgetExceededError(exhausted, output)
        options.onEvent?.({ type: "agent_completed", agent: agentId, message: output.slice(0, 160) })
        return output
      } catch (error) {
        options.onEvent?.({
          type: "agent_failed",
          agent: agentId,
          message: (error as Error).message.slice(0, 500),
        })
        throw error
      } finally {
        await mutateDoc<AgentDoc>("agents", agentId, (row) => row && { ...row, status: "idle", updated_at: Date.now() })
      }
    }

    // The budget belongs to the task: BEE and every worker it launches spend from the same one.
    setTaskBudget(taskId, routeBudget(weight.tier, process.env, weight.statement.reading || weight.statement.planning))
    try {
      if (complexity === "conversation") {
        const reading = weight.statement.reading || weight.statement.planning
        const projectFacts = reading ? describeProjectFacts(weight.project) : ""
        const lead = [weight.statement.reading ? DB_FIRST_READING : "", weight.statement.planning ? PLAN_AFTER_READING : ""].filter(Boolean).join("\n\n")
        const task = reading ? `${lead}\n${projectFacts ? `\n${projectFacts}\n` : ""}\nObjetivo:\n${objective}` : objective
        const response = await invoke("bee", task, "harness")
        await updateStage("completed")
        return { taskId, complexity, route: weight.tier, routeSignals: weight.signals, status: "completed", response, repairCycles: 0 }
      }

      if (complexity === "simple_change") {
        if (policy === "plan") {
          const response = await invoke(
            "bee",
            `Modo plan: describe un plan breve y localizado para este cambio. Puedes delegar investigación a Scout o Spider y consultas técnicas a los especialistas cuando hagan falta; sus entregas deben ser de análisis. No modifiques código ni inicies Spec Kit.\n\n${objective}`,
            "harness",
          )
          await updateStage("ready")
          return { taskId, complexity, route: weight.tier, routeSignals: weight.signals, status: "ready", response, repairCycles: 0 }
        }
        await updateStage("executing")
        // What BEE would otherwise spend turns finding out: how the project runs and what the harness
        // will check by itself at the end.
        const planned = planChecks(options.workspace)
        const projectFacts = describeProjectFacts(
          weight.project,
          [...new Set(planned.filter(p => !p.skip).map(p => p.label))],
          // What the harness will not check, and why: a missing toolchain is said, not left to look like a pass.
          [
            ...planned.filter(p => p.command && !p.skip).map(p => `${p.label} (${p.ecosystem}): \`${p.command}\``),
            ...planned.filter(p => p.skip).map(p => `${p.label} (${p.ecosystem}): no se comprobará — ${p.skip}`),
          ],
        )
        let response = await invoke(
          "bee",
          `Cambio pequeño y localizado: no inicies Spec Kit. Hazlo tú directamente: busca y lee lo necesario
(agrupa en un mismo paso las lecturas independientes), edita (fs_edit admite varios cambios por llamada
con edits[]) y comprueba tu cambio con la prueba o el chequeo que le toque. No lo delegues al worker
"builder" salvo que el trabajo resulte ser grande o tenga bloques independientes que ganen en paralelo;
si empieza a crecer, delega ese bloque con task_delegate y criterios de aceptación concretos.
No llames al worker "verifier": la verificación determinista (pruebas, tipos, build) ya se ejecuta sola
sobre el resultado y su veredicto va en el informe. Un gate por modelo aquí duplica ese trabajo con un
presupuesto de minutos, y medido el 21-oct-2026 se comía 19 turnos y el 27 % de los tokens de la tarea.
Responde al usuario con un resumen compacto: archivos tocados y pruebas ejecutadas, sin repetir logs
ni afirmar pruebas que no estén en la evidencia.
${projectFacts ? `\n${projectFacts}\n` : ""}
Objetivo:
${objective}`,
          "harness",
          false,
          SCOPED_REASONING,
        )

        // La verificación determinista: se ejecuta el proyecto. Cuesta segundos, no minutos, y su
        // veredicto no depende de quién juzgue. Si sale en rojo, un ciclo de reparación; si
        // vuelve a salir en rojo, la tarea se reporta como fallida con la evidencia, no como buena.
        let verdict = await verifyDeterministic(options.workspace, options.signal)
        let repairCycles = 0
        if (!verdict.ok) {
          await updateStage("reviewing")
          const failed = verdict.checks.filter(c => c.status === "failed")
          response = await invoke(
            "bee",
            `La verificación del proyecto salió en rojo. Corrígelo tú directamente (o, si el arreglo es grande,
delegá ese bloque al worker "builder" con task_delegate o task_revise), y después resumí qué
cambiaste. No afirmes que las pruebas pasan si no lo has comprobado.

Comprobaciones en rojo:
${failed.map(c => `- ${c.name}: ${c.detail}`).join("\n")}

Objetivo original:
${objective}`,
            "harness",
            false,
            REPAIR_REASONING,
          )
          repairCycles = 1
          verdict = await verifyDeterministic(options.workspace, options.signal)
        }

        await updateStage(verdict.ok ? "completed" : "failed")
        return {
          taskId, complexity, route: weight.tier, routeSignals: weight.signals,
          status: verdict.ok ? "completed" : "failed",
          response: `${response}\n\n${describeVerdict(verdict)}`,
          repairCycles,
        }
      }

      // A plan approved after a `plan` run is reused, not redone. Only if its artifacts are still
      // there: they live in the workspace, and a resumed task may be pointed at another one.
      const reusablePlan = existing?.doc.planId && await directoryExists(path.join(options.workspace, existing.doc.planId))
        ? existing.doc.planId
        : undefined
      let planning = reusablePlan
        ? `Reanudando artefactos Spec Kit desde ${reusablePlan}.`
        : ""
      let featureDir = reusablePlan
      if (!featureDir) {
        await updateStage("planning")
        planning = await invoke(
          "bee",
          `Tarea compleja. No planifiques tú: delega el plan al worker "planner" con task_delegate.

1. Llama task_delegate con worker_id="planner" y como task_description el objetivo completo (y el contexto
   que ya conozcas). Criterios de aceptación: spec.md, plan.md y tasks.md existen y pasan speckit_validate;
   cada tarea tiene lane, archivos propios, dependencias y criterios verificables.
2. Si necesitas contexto previo del código, delega antes una investigación al worker "scout" (en paralelo
   con el planner si son independientes).
3. Revisa el handoff; si el plan no cumple, devuélvelo con task_revise.
4. No implementes. En tu respuesta incluye exactamente "FEATURE_DIR: specs/..." y un resumen del plan.

Objetivo:
${objective}`,
          "harness",
        )
        featureDir = /FEATURE_DIR:\s*`?(specs\/[a-z0-9._-]+)`?/i.exec(planning)?.[1]
          ?? await newestFeatureDir(options.workspace)
      }
      if (!featureDir) throw new Error("BEE did not create a Spec Kit feature directory")
      await updateStage("ready", { planId: featureDir })

      if (policy === "plan" && !existing) {
        return { taskId, complexity, route: weight.tier, routeSignals: weight.signals, status: "ready", response: planning, featureDir, repairCycles: 0 }
      }
      const needsSpecificationApproval = !existing
        || existing.doc.nextAction === "approve_specification"
        || existing.doc.stage === "ready"
      if (policy === "approval" && needsSpecificationApproval) {
        await updateStage("waiting_user", { nextAction: "approve_specification" })
        // Sin approver cableado (p.ej. el reintento del recovery scheduler) nadie puede
        // responder: la tarea queda esperando decisión, no se descarta. El stage ya está
        // persistido, así que es retomable. Mismo criterio que el gate de convergencia.
        if (!options.approve) {
          return { taskId, complexity, route: weight.tier, routeSignals: weight.signals, status: "waiting_user", response: planning, featureDir, repairCycles: 0 }
        }
        const decision = await options.approve("specification", await specificationEvidence(options.workspace, featureDir, planning))
        if (decision !== "approve") {
          await updateStage("cancelled")
          return { taskId, complexity, route: weight.tier, routeSignals: weight.signals, status: "cancelled", response: planning, featureDir, repairCycles: 0 }
        }
      }

      await updateStage("executing", { nextAction: undefined })
      let repairCycles = 0
      let quality = ""
      let prompt = `Ejecuta el plan de ${featureDir}.

1. Lee tasks.md con speckit_artifact_read.
2. Delega las tareas con task_delegate al worker de su lane (scout, builder, spider). Las tareas listas
   que no comparten archivos se delegan EN EL MISMO PASO (varias llamadas task_delegate juntas) para que
   corran en paralelo. Para dos trabajos de código simultáneos usa instancias del mismo perfil: worker_id
   "builder", "builder#2", "builder#3" (cada una trabaja en su copia del proyecto y su trabajo se fusiona al
   terminar; no repartas el mismo archivo entre instancias). Una tarea que necesita el resultado de otra se
   delega en el MISMO paso con after: ["T001"]: espera sola, sin gastar tokens, y recibe esa entrega. Si
   una dependencia falla, la llamada vuelve con blocked_by: decide tú (task_revise a la que falló).
   Máximo ${MAX_PARALLEL_WORKERS} workers a la vez. Reparte la ola completa de tareas listas en un solo paso
   en vez de delegarlas de una en una.
3. Cada delegación lleva criterios de aceptación tomados de la tarea. Si el resultado trae
   acceptance_met: true, la tarea ya está verificada: no la revises, sigue. Si es null, juzga la evidencia; si
   no cumple, task_revise con feedback concreto. Como mucho dos revisiones por tarea: si sigue sin cumplir,
   acéptala con la salvedad o delégala de nuevo con un brief distinto.
4. Cuando todas estén hechas, delega al worker "verifier" (Quality Gate): reproducir cada criterio de
   aceptación de ${featureDir} contra el sistema real y revisar el diff. Debe terminar con "VERDICT: PASS" o "VERDICT: FAIL".
5. Termina tu respuesta con el veredicto del Quality Gate tal cual ("VERDICT: PASS" o "VERDICT: FAIL"), la
   evidencia y los archivos tocados.`
      while (true) {
        quality = await invoke("bee", prompt, "harness", true)
        await updateStage("reviewing")
        if (passed(quality)) break
        if (repairCycles >= DEFAULT_MAX_REPAIR_CYCLES) {
          throw new Error(`Quality gate did not converge after ${repairCycles} repair cycles`)
        }
        repairCycles++
        await updateStage("executing", { nextAction: `repair_cycle_${repairCycles}` })
        prompt = `Ciclo de reparación ${repairCycles}/${DEFAULT_MAX_REPAIR_CYCLES} para ${featureDir}.
Corrige solo los fallos accionables del Quality Gate (delega a "builder" con task_delegate o devuelve la
tarea con task_revise), conserva lo que ya pasa y vuelve a delegar el Quality Gate al "verifier".
Termina con "VERDICT: PASS" o "VERDICT: FAIL".

QUALITY GATE ANTERIOR:
${quality}`
      }

      const convergence = await invoke(
        "bee",
        `Consolida la tarea ${featureDir}. Llama speckit_converge con gaps=[] y la evidencia siguiente.
Después responde al usuario con un resumen compacto de resultado, archivos y pruebas.

GATE DE CALIDAD (verificación + revisión):
${quality}`,
        "harness",
      )

      if (policy === "approval") {
        await updateStage("waiting_user", { nextAction: "approve_convergence" })
        const decision = await options.approve?.("convergence", convergence)
        if (decision !== "approve") {
          return { taskId, complexity, route: weight.tier, routeSignals: weight.signals, status: "waiting_user", response: convergence, featureDir, repairCycles }
        }
      }

      await updateStage("completed", { nextAction: undefined })
      return { taskId, complexity, route: weight.tier, routeSignals: weight.signals, status: "completed", response: convergence, featureDir, repairCycles }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        // Not a quality failure: the task is bigger than its route expected. Report what was done.
        await updateStage("failed", { blocker: error.message, nextAction: "inspect_or_resume" })
        options.onEvent?.({ type: "budget_exceeded", message: error.blocker })
        const usage = taskBudgetUsage(taskId)
        const spent = usage ? `${Math.round(usage.inputTokens / 1000)} K de entrada y ${Math.round(usage.outputTokens / 1000)} K de salida` : "su presupuesto"
        return {
          taskId, complexity, route: weight.tier, routeSignals: weight.signals, status: "failed",
          response: `${error.partial}\n\nPresupuesto agotado (budget_exceeded): la tarea gastó ${spent} de tokens y se detuvo en el tope de la ruta ${weight.tier} (${error.blocker}). Es más grande de lo que parecía: lo hecho hasta aquí queda en el proyecto, sin verificar. Reintenta con un objetivo más acotado o con HIVECODE_BUDGET_SCALE mayor.`.trim(),
          repairCycles: 0,
          budgetExceeded: error.blocker,
        }
      }
      await updateStage(options.signal?.aborted ? "cancelled" : "failed", { blocker: (error as Error).message, nextAction: "inspect_or_resume" })
      throw error
    } finally {
      clearTaskBudget(taskId)
    }
  }
}
