import { readdir } from "node:fs/promises"
import * as path from "node:path"
import { col, fromIndexable } from "../storage/hive.ts"
import type { AgentDoc, HarnessTaskDoc, JobDoc } from "../storage/collections.ts"
import { CORE_AGENT_DEFINITIONS, ensureCoreAgentProfiles, type CoreAgentType } from "../agent/agent-profiles.ts"
import { runAgentIsolated } from "../agent/agent-loop.ts"
import type { StepEvent } from "../agent/agent-loop.ts"
import {
  AdaptiveScheduler,
  classifyTask,
  DEFAULT_MAX_AGENT_CONCURRENCY,
  DEFAULT_MAX_REPAIR_CYCLES,
  type ScheduledJobPayload,
  type TaskComplexity,
} from "./adaptive-scheduler.ts"

export type HarnessApprovalGate = "specification" | "convergence"
export type HarnessApprovalDecision = "approve" | "cancel"

export interface ProfileHarnessOptions {
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
  /** Existing durable harness task to continue without repeating completed DAG nodes. */
  resumeTaskId?: string
  /** Compatibility task ID used by the outer code-session projection. */
  parentTaskId?: string
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

const PASS_RE = /\b(?:VERDICT|VEREDICTO|STATUS|ESTADO)\s*:\s*(?:PASS|PASSED|APPROVED|APROBADO|CUMPLE)\b/i
const FAIL_RE = /\b(?:VERDICT|VEREDICTO|STATUS|ESTADO)\s*:\s*(?:FAIL|FAILED|REJECTED|RECHAZADO|NO CUMPLE)\b/i

function laneProfile(job: JobDoc): CoreAgentType {
  if (job.lane === "scout") return "scout"
  if (job.lane === "verifier") return "verifier"
  if (job.lane === "reviewer") return "reviewer"
  return "builder"
}

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
  const agents = await col<AgentDoc>("agents")
  for (const id of ["bee", "scout", "builder", "verifier", "reviewer"] as CoreAgentType[]) {
    const row = await agents.get(id)
    if (!row) continue
    await agents.put(id, {
      ...row.doc,
      workspace,
      provider_id: provider || fromIndexable(row.doc.provider_id) || row.doc.provider_id,
      model_id: model || fromIndexable(row.doc.model_id) || row.doc.model_id,
      updated_at: Date.now(),
    }, { expectedVersion: row.version })
  }
}

/**
 * Canonical long-task orchestrator. It keeps model calls in the shared native
 * agent loop; this class owns routing, gates, DAG scheduling and repair policy.
 */
export class ProfileHarness {
  constructor(
    private readonly runner: ProfileRunner = runAgentIsolated as ProfileRunner,
    private readonly scheduler = new AdaptiveScheduler(DEFAULT_MAX_AGENT_CONCURRENCY),
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
      options.onEvent?.({ type: "agent_activated", agent: agentId, message: taskDescription })
      const agents = await col<AgentDoc>("agents")
      const before = await agents.get(agentId)
      if (before) {
        await agents.put(agentId, { ...before.doc, status: "busy", updated_at: Date.now() }, { expectedVersion: before.version })
      }
      try {
        const output = await this.runner({
          agentId,
          taskDescription,
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
        const after = await agents.get(agentId)
        if (after) {
          await agents.put(agentId, { ...after.doc, status: "idle", updated_at: Date.now() }, { expectedVersion: after.version })
        }
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
        const implementation = await invoke(
          "builder",
          `Implementa este cambio pequeño y localizado sin iniciar Spec Kit:\n\n${objective}\n\nDevuelve un handoff compacto con archivos y pruebas.`,
        )
        const response = await invoke(
          "bee",
          `Sintetiza para el usuario este handoff de Builder. No repitas logs ni afirmes pruebas no presentes.\n\nObjetivo:\n${objective}\n\nHandoff:\n${implementation}`,
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
          `Tarea compleja; aplica obligatoriamente la skill spec-kit.

Coordinás: no explorás el código a mano. Tu loadout son las herramientas speckit_* y
search_knowledge, que busca sobre herramientas, skills, MCP, playbook y el código del
proyecto. Si necesitás investigación profunda, dejala como tarea de lane [scout] en
tasks.md en vez de intentar hacerla vos.

1. Llama speckit_init.
2. Usa search_knowledge para el contexto que te falte del proyecto.
3. Completa spec.md, plan.md y analysis.md con speckit_artifact_write.
4. Valida spec y plan con speckit_validate.
5. Escribe tasks.md con tareas TNNN, lane [scout|builder], ownership y dependencias explícitas.
6. Llama speckit_tasks_sync usando run_id="${taskId}".

No guardes notas de progreso: los artefactos Spec Kit son tu registro.
Detente antes de implementar. En la respuesta incluye exactamente "FEATURE_DIR: specs/...".

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
        const decision = await options.approve?.("specification", planning)
        if (decision !== "approve") {
          await updateStage("cancelled")
          return { taskId, complexity, status: "cancelled", response: planning, featureDir, repairCycles: 0 }
        }
      }

      await updateStage("executing", { nextAction: undefined })
      const scheduled = await this.scheduler.run(taskId, async (job, payload: ScheduledJobPayload) => {
        const profile = laneProfile(job)
        const output = await invoke(
          profile,
          `Ejecuta solo esta tarea del DAG.
Feature: ${featureDir}
Task: ${payload.id}
Depends on: ${payload.dependsOn.join(", ") || "none"}
Description: ${payload.description}
Respeta la spec, el plan, ownership, permisos y el workspace. Devuelve evidencia y handoff.`,
          "worker",
          true,
        )
        if (FAIL_RE.test(output)) throw new Error(output.slice(0, 500))
      })
      if (scheduled.failed.length || scheduled.blocked.length) {
        throw new Error(
          `DAG incomplete. Failed: ${scheduled.failed.map(item => item.id).join(", ") || "none"}; ` +
          `blocked: ${scheduled.blocked.join(", ") || "none"}`,
        )
      }

      let repairCycles = 0
      let verification = ""
      let review = ""
      while (true) {
        await updateStage("reviewing")
        verification = await invoke(
          "verifier",
          `Verifica todos los criterios de aceptación de ${featureDir} contra el sistema real.
No modifiques código. Incluye comandos/evidencia y termina con "VERDICT: PASS" o "VERDICT: FAIL".`,
          "verification",
        )
        review = await invoke(
          "reviewer",
          `Revisa independientemente el diff, spec, plan, tasks y esta evidencia de Verifier:

${verification}

No modifiques código. Termina con "VERDICT: PASS" o "VERDICT: FAIL".`,
          "review",
        )
        if (passed(verification) && passed(review)) break
        if (repairCycles >= DEFAULT_MAX_REPAIR_CYCLES) {
          throw new Error(`Verification/review did not converge after ${repairCycles} repair cycles`)
        }
        repairCycles++
        await updateStage("executing", { nextAction: `repair_cycle_${repairCycles}` })
        await invoke(
          "builder",
          `Repair cycle ${repairCycles}/${DEFAULT_MAX_REPAIR_CYCLES} for ${featureDir}.
Fix only actionable failures below, preserve passing behavior, then run focused tests.

VERIFIER:
${verification}

REVIEWER:
${review}`,
          "worker",
          true,
        )
      }

      const convergence = await invoke(
        "bee",
        `Consolida la tarea ${featureDir}. Llama speckit_converge con gaps=[] y la evidencia siguiente.
Después responde al usuario con un resumen compacto de resultado, archivos y pruebas.

VERIFIER:
${verification}

REVIEWER:
${review}`,
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
      await updateStage("failed", { blocker: (error as Error).message, nextAction: "inspect_or_resume" })
      throw error
    }
  }
}
