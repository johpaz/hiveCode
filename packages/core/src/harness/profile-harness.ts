import { readdir } from "node:fs/promises"
import * as path from "node:path"
import { col, fromIndexable, mutateDoc } from "../storage/hive.ts"
import type { AgentDoc, HarnessTaskDoc } from "../storage/collections.ts"
import { CORE_AGENT_DEFINITIONS, ensureCoreAgentProfiles, type CoreAgentType } from "../agent/agent-profiles.ts"
import { runAgentIsolated } from "../agent/agent-loop.ts"
import type { StepEvent } from "../agent/agent-loop.ts"
import {
  classifyTask,
  DEFAULT_MAX_REPAIR_CYCLES,
  type TaskComplexity,
} from "./adaptive-scheduler.ts"

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
  status: HarnessTaskDoc["stage"]
  response: string
  featureDir?: string
  repairCycles: number
}

export type ProfileRunner = (opts: {
  signal?: AbortSignal
  agentId: CoreAgentType
  taskDescription: string
  threadId: string
  parentRunId?: string
  runKind?: "worker" | "harness" | "verification" | "review"
  approvedExecution?: boolean
  onStep?: (step: StepEvent) => Promise<void>
  maxSteps?: number
}) => Promise<string>

/**
 * Step ceiling for BEE's orchestration turns.
 *
 * Was 16, which the Spec Kit planning prompt alone cannot fit: speckit_init, discovery,
 * three artifacts, validation, tasks.md and tasks_sync run well past that, so the
 * planning turn died on budget every time.
 */
export const DEFAULT_MAX_HARNESS_STEPS = 40

/** Workers BEE may run at once; mutating ones are serialized per file set by its own instructions. */
export const MAX_PARALLEL_WORKERS = 3

const PASS_RE = /\b(?:VERDICT|VEREDICTO|STATUS|ESTADO)\s*:\s*(?:PASS|PASSED|APPROVED|APROBADO|CUMPLE)\b/i
const FAIL_RE = /\b(?:VERDICT|VEREDICTO|STATUS|ESTADO)\s*:\s*(?:FAIL|FAILED|REJECTED|RECHAZADO|NO CUMPLE)\b/i

function passed(output: string): boolean {
  return PASS_RE.test(output) && !FAIL_RE.test(output)
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

async function configureProfiles(workspace: string, provider?: string, model?: string): Promise<void> {
  await ensureCoreAgentProfiles()
  for (const id of ["bee", "scout", "planner", "builder", "verifier", "spider"] as CoreAgentType[]) {
    await mutateDoc<AgentDoc>("agents", id, (row) => row && {
      ...row,
      workspace,
      provider_id: provider || fromIndexable(row.provider_id) || row.provider_id,
      model_id: model || fromIndexable(row.model_id) || row.model_id,
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
    const complexity = classifyTask(objective)
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
      createdAt: now,
      updatedAt: now,
    }
    if (!existing) await tasks.put(taskId, task, { expectedVersion: 0 })
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
    ) => {
      options.signal?.throwIfAborted()
      options.onEvent?.({ type: "agent_activated", agent: agentId, message: taskDescription })
      await mutateDoc<AgentDoc>("agents", agentId, (row) => row && { ...row, status: "busy", updated_at: Date.now() })
      try {
        const output = await this.runner({
          signal: options.signal,
          agentId,
          taskDescription: agentId === "bee" ? sessionPreamble + taskDescription : taskDescription,
          threadId: taskId,
          parentRunId: taskId,
          runKind,
          approvedExecution,
          // Never cap below what the profile declares it needs — the override is here to
          // bound orchestration cost, not to shrink a profile's own budget.
          maxSteps: runKind === "harness"
            ? Math.max(DEFAULT_MAX_HARNESS_STEPS, CORE_AGENT_DEFINITIONS[agentId]?.maxTurns ?? 0)
            : undefined,
          onStep: async step => {
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

    try {
      if (complexity === "conversation") {
        const response = await invoke("bee", objective, "harness")
        await updateStage("completed")
        return { taskId, complexity, status: "completed", response, repairCycles: 0 }
      }

      if (complexity === "simple_change") {
        if (policy === "plan") {
          const response = await invoke(
            "bee",
            `Modo plan: describe un plan breve y localizado para este cambio. No modifiques código ni inicies Spec Kit.\n\n${objective}`,
            "harness",
          )
          await updateStage("ready")
          return { taskId, complexity, status: "ready", response, repairCycles: 0 }
        }
        await updateStage("executing")
        const response = await invoke(
          "bee",
          `Cambio pequeño y localizado: no inicies Spec Kit. Delégalo al worker "builder" con task_delegate
(con criterios de aceptación concretos) y juzga su handoff; si no cumple, usa task_revise.
Responde al usuario con un resumen compacto: archivos tocados y pruebas ejecutadas, sin repetir logs
ni afirmar pruebas que no estén en la evidencia.

Objetivo:
${objective}`,
          "harness",
        )
        await updateStage("completed")
        return { taskId, complexity, status: "completed", response, repairCycles: 0 }
      }

      let planning = existing?.doc.planId
        ? `Reanudando artefactos Spec Kit desde ${existing.doc.planId}.`
        : ""
      let featureDir = existing?.doc.planId
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
        return { taskId, complexity, status: "ready", response: planning, featureDir, repairCycles: 0 }
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
          return { taskId, complexity, status: "waiting_user", response: planning, featureDir, repairCycles: 0 }
        }
        const decision = await options.approve("specification", planning)
        if (decision !== "approve") {
          await updateStage("cancelled")
          return { taskId, complexity, status: "cancelled", response: planning, featureDir, repairCycles: 0 }
        }
      }

      await updateStage("executing", { nextAction: undefined })
      let repairCycles = 0
      let quality = ""
      let prompt = `Ejecuta el plan de ${featureDir}.

1. Lee tasks.md con speckit_artifact_read.
2. Delega las tareas con task_delegate al worker de su lane (scout, builder, spider). Las tareas listas
   que no comparten archivos ni dependencias se delegan EN EL MISMO PASO (varias llamadas task_delegate
   juntas) para que corran en paralelo; las que dependen de otra esperan su resultado. Máximo ${MAX_PARALLEL_WORKERS}
   workers a la vez y un solo builder por conjunto de archivos.
3. Cada delegación lleva criterios de aceptación tomados de la tarea. Juzga la evidencia de cada una; si
   no cumple, task_revise con feedback concreto antes de seguir.
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
          return { taskId, complexity, status: "waiting_user", response: convergence, featureDir, repairCycles }
        }
      }

      await updateStage("completed", { nextAction: undefined })
      return { taskId, complexity, status: "completed", response: convergence, featureDir, repairCycles }
    } catch (error) {
      await updateStage(options.signal?.aborted ? "cancelled" : "failed", { blocker: (error as Error).message, nextAction: "inspect_or_resume" })
      throw error
    }
  }
}
