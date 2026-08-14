import { col } from "@johpaz/hivecode-core/storage/hive"
import type { AgentMemoryDoc, CodeConfigDoc, CodePlaybookDoc, CodeSessionDoc, CodeTaskPhaseDoc, HarnessTaskDoc, ModelDoc, WorkerActivityDoc } from "@johpaz/hivecode-core/storage/collections"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import { computeBackoffDelay } from "@johpaz/hivecode-core/utils/retry"
import { createAllTools } from "@johpaz/hivecode-core/tools"
import { ProfileHarness } from "@johpaz/hivecode-core/harness/profile-harness"
import { classifyTask } from "@johpaz/hivecode-core/harness/adaptive-scheduler"
import type { Config } from "@johpaz/hivecode-core/config"
import { loadConfig } from "@johpaz/hivecode-core/config"
import type { Tool } from "@johpaz/hivecode-core/tools"
import { selectSkills, getMinimalSkills, type SkillDescriptor } from "@johpaz/hivecode-core/agent/skill-selector"
import {
  getMode, setMode, getPhaseIndex, setPhaseIndex,
  setWorkerBusy, isWorkerBusy, setCancelled, isCancelled,
} from "../modes/session-array"
import { Scribe } from "../narrative/scribe"
import type { Turn, FileChange } from "../narrative/scribe"
import { loadSecrets, distributeSecrets } from "./secrets"
import { getToolsForCoordinator, executeToolByName } from "./tool-bridge"
import { parsePlan, getDefaultPhases, groupPhasesByLevel } from "./plan-parser"
import type { ParsedPhase } from "./plan-parser"

/** Shape of the `submit_review_verdict` structured decision (see worker-handler.ts). */
interface ReviewVerdict {
  verdict: "aprobado" | "aprobado_con_observaciones" | "rechazado"
  criteria: Array<{ description: string; met: boolean; evidence?: string }>
  categories?: Array<{ name: string; status: "ok" | "warning" | "blocking"; detail?: string }>
  reasons?: string
}
import { checkAutomaticInterruption } from "../modes/interruptions"
import { broadcastNarrative, broadcastPhase, broadcastMode, broadcastPhaseStart, broadcastPhaseEnd, broadcastTaskEnd, broadcastThinking } from "@johpaz/hivecode-core/gateway/task-streaming"
import { validateCommand } from "@johpaz/hivecode-core/tools/code/command-validator"
import { incrementTaskCounter, shouldRunReflector, runReflector, startReflectorCron, stopReflectorCron } from "../agent/reflector"
import { updateFileIndex } from "../agent/code-indexer"
import { getProjectContext } from "../agent/context-retriever"
import { existsSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "@johpaz/hivecode-core/gateway/helpers/path"
import { TaskSupervisor } from "../runtime/task-supervisor"
import { WorkspaceLeaseManager, type WorkspaceLease, type WorkspaceLeaseOperation } from "../workspace/leases"
import { WorkspaceManager, type WorkspaceAssignment } from "../workspace/manager"
import type {
  CoordinatorTask, CoordinatorResult, BeeDecision, ControlMessage,
  PhaseName, SessionMode, CoordinatorStatus,
  WorkerToManagerMessage, ManagerToWorkerMessage,
} from "./types"
import { CoordinatorBase } from "../coordinator/base.ts"
import { makeGatewayEmitter } from "../context/ipc-emitter.ts"
import { SystemError, TimeoutError } from "../errors/hive-errors.ts"
import {
  parseBeeDecision, normalizeBeeDecision, formatBeeNarrative, formatToolCallForHuman,
  formatToolResult, parseGitDiffStat, parseUnifiedDiff,
  smartTruncate, smartTruncateLines,
} from "../coordinator/utils.ts"

const log = logger.child("coordinator-manager")

async function getCodeConfig(key: string): Promise<string> {
  return (await (await col<CodeConfigDoc>("codeConfig")).get(key))?.doc.value ?? ""
}

// BEE is index 0 in the bitmask; coordinators follow in the pool
// librarian and forensic are on-demand workers — not in the persistent pool
const COORDINATOR_NAMES: PhaseName[] = [
  "bee", "architecture",
  "product_manager",
  "backend", "frontend",
  "data_scientist",
  "security", "test", "devops",
  "verifier", "reviewer",
]

/** Circuit breaker: stop auto-restarting a coordinator after this many consecutive crashes. */
const MAX_WORKER_RESTARTS = 5

type NarrativeChunkCallback = (chunk: {
  coordinator: string
  phase: string
  content: string
  streamId?: string
  taskId?: string
  sessionId?: string
}) => void

// Bun --compile only embeds workers when new Worker(new URL(...)) is a LITERAL call.
// Variables or map lookups are not statically detected. The switch below ensures
// every worker URL is visible to the bundler at compile time.
function spawnCoordinatorWorker(name: PhaseName): Bun.Worker {
  const smol = name === "security" || name === "devops"
  switch (name) {
    case "bee":             return new (Worker as any)(new URL("./bee.worker.ts",             import.meta.url), { smol }) as Bun.Worker
    case "architecture":    return new (Worker as any)(new URL("./architecture.worker.ts",    import.meta.url), { smol }) as Bun.Worker
    case "product_manager": return new (Worker as any)(new URL("./product-manager.worker.ts", import.meta.url), { smol }) as Bun.Worker
    case "backend":         return new (Worker as any)(new URL("./backend.worker.ts",         import.meta.url), { smol }) as Bun.Worker
    case "frontend":        return new (Worker as any)(new URL("./frontend.worker.ts",        import.meta.url), { smol }) as Bun.Worker
    case "data_scientist":  return new (Worker as any)(new URL("./data-scientist.worker.ts",  import.meta.url), { smol }) as Bun.Worker
    case "security":        return new (Worker as any)(new URL("./security.worker.ts",        import.meta.url), { smol }) as Bun.Worker
    case "test":            return new (Worker as any)(new URL("./test.worker.ts",            import.meta.url), { smol }) as Bun.Worker
    case "devops":          return new (Worker as any)(new URL("./devops.worker.ts",          import.meta.url), { smol }) as Bun.Worker
    case "verifier":        return new (Worker as any)(new URL("./verifier.worker.ts",        import.meta.url), { smol }) as Bun.Worker
    case "reviewer":        return new (Worker as any)(new URL("./reviewer.worker.ts",        import.meta.url), { smol }) as Bun.Worker
    case "librarian":       return new (Worker as any)(new URL("./librarian.worker.ts",       import.meta.url), { smol }) as Bun.Worker
    case "forensic":        return new (Worker as any)(new URL("./forensic.worker.ts",        import.meta.url), { smol }) as Bun.Worker
    default:                throw new Error(`Unknown coordinator: ${name}`)
  }
}

export class CoordinatorManager extends CoordinatorBase {
  private workers: Map<PhaseName, Bun.Worker> = new Map()
  /** Consecutive crash count per coordinator; resets on any successful message. */
  private workerCrashCounts = new Map<PhaseName, number>()
  private scribe = new Scribe()
  private activeTaskId: string | null = null
  private activeSessionId: string | null = null
  private broadcastChannel: BroadcastChannel | null = null
  private pendingResolvers = new Map<string, { resolve: (value: CoordinatorResult) => void; reject: (err: Error) => void }>()
  private pendingTimeouts  = new Map<string, ReturnType<typeof setTimeout>>()
  private secrets: Record<string, string> = {}
  private allTools: Tool[] = []
  private toolWorkerPool: Bun.Worker[] = []
  private currentLevel = 0
  private taskSupervisor = new TaskSupervisor()
  private workspaceManager = new WorkspaceManager()
  private workspaceLeases = new WorkspaceLeaseManager()
  private taskWorkspaces = new Map<string, WorkspaceAssignment>()
  private preparedWorkspaces = new Set<string>()
  private idleToolWorkers: Bun.Worker[] = []
  private toolResolvers = new Map<string, (res: any) => void>()
  private onNarrativeChunk?: NarrativeChunkCallback
  private onWorkerUpdate?: (update: { type: "tool_worker"; id: number; status: "idle" | "busy"; tool?: string }) => void
  private onTaskComplete?: (response: string) => void
  private onIpcEvent?: (event: string, payload: unknown) => void
  private onModeChangeCb?: (mode: SessionMode) => void

  /** Reload enabled provider keys from Bun.secrets only. */
  async reloadSecrets(): Promise<void> {
    this.secrets = await loadSecrets()
    const totalKeys = Object.keys(this.secrets).length
    if (totalKeys === 0) {
      console.info(
        `[secrets] ℹ️  No API keys configured yet — agents will start but tasks need a provider.\n` +
        `   Run: hivecode provider add   (or set <PROVIDER>_API_KEY env var)`
      )
    }

    distributeSecrets(this.secrets)
    log.info(`[coordinator-manager] Secrets reloaded — ${totalKeys} key(s)`)
  }

  async startAll(): Promise<void> {
    log.info("[coordinator-manager] Starting lazy harness runtime...")

    // Load and distribute secrets BEFORE creating workers
    await this.reloadSecrets()

    // Rehydrate durable state from HiveDB so recovery/resume reads see prior
    // sessions, then reconcile any task a previous process left mid-flight.
    await this.scribe.hydrate()
    this.reconcileInterruptedTasks()

    // Load all tools from core
    try {
      const config = await loadConfig()
      this.allTools = createAllTools(config)
      log.info(`[coordinator-manager] 📦 Loaded ${this.allTools.length} tools`)
    } catch (err) {
      log.warn(`[coordinator-manager] ⚠️  Failed to load tools: ${(err as Error).message}`)
      this.allTools = []
    }

    this.broadcastChannel = new BroadcastChannel("hivecode:control")
    this.broadcastChannel.onmessage = (event: any) => this.handleControlMessage(event.data as ControlMessage)

    startReflectorCron()
    log.info("[coordinator-manager] ✅ Runtime ready — agents and tool workers activate on demand")
  }

  /**
   * Boot-time reconciliation: a task left `running`/`planning` by a process that
   * died is not really running anymore. Move it to `paused` (resumable) when a
   * recovery point exists, or `failed` when it doesn't, and surface a
   * `resume_available` signal so the TUI can offer to continue it. Runs after
   * `scribe.hydrate()`, so the in-memory task/recovery-point caches are populated.
   */
  private reconcileInterruptedTasks(): void {
    const interrupted = this.scribe.findInterruptedTasks()
    if (interrupted.length === 0) return
    log.info(`[coordinator-manager] 🔧 Reconciling ${interrupted.length} interrupted task(s) from a previous process`)
    for (const task of interrupted) {
      const recovery = this.scribe.getLatestRecoveryPoint(task.id)
      if (recovery) {
        this.scribe.updateTaskStatus(task.id, "paused")
        log.info(`[coordinator-manager] ⏸️  Task ${task.id} paused at level ${recovery.completedPhases.length} — resume available`)
        this.onIpcEvent?.("resume_available", {
          task_id: task.id,
          checkpoint_id: recovery.id,
          reason: `Interrupted at level ${recovery.completedPhases.length}; ${recovery.pendingPhases.length} phase(s) pending.`,
        })
      } else {
        this.scribe.updateTaskStatus(task.id, "failed")
        log.info(`[coordinator-manager] ✗ Task ${task.id} marked failed — no recovery point to resume from`)
      }
    }
  }

  private initToolPool(size: number): void {
    // URL embebida estáticamente por Bun --compile
    for (let i = 0; i < size; i++) {
      const worker = new (Worker as any)(new URL("./tool.worker.ts", import.meta.url), { smol: true }) as Bun.Worker
      worker.onmessage = (msg: MessageEvent) => {
        const data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data
        if (data.type === "TOOL_RESULT") {
          const resolver = this.toolResolvers.get(data.toolCallId)
          if (resolver) {
            resolver(data.result || { ok: false, error: data.error })
            this.toolResolvers.delete(data.toolCallId)
          }
          this.idleToolWorkers.push(worker)
          const workerId = this.toolWorkerPool.indexOf(worker)
          if (this.onWorkerUpdate) this.onWorkerUpdate({ type: "tool_worker", id: workerId, status: "idle" })
        }
      }
      this.toolWorkerPool.push(worker)
      this.idleToolWorkers.push(worker)
    }
  }

  private async executeInToolWorker(toolName: string, toolArgs: any, config: any): Promise<any> {
    if (this.toolWorkerPool.length === 0) {
      // Three is the global adaptive concurrency ceiling. The pool is created
      // only for the first actual tool call, so idle startup has zero workers.
      this.initToolPool(3)
      log.info("[coordinator-manager] Tool pool activated lazily (max concurrency: 3)")
    }
    const worker = this.idleToolWorkers.pop()
    if (!worker) {
      // Fallback to main thread if pool is busy
      return executeToolByName(this.allTools, toolName, toolArgs, config)
    }

    const toolCallId = Bun.randomUUIDv7()
    const workerId = this.toolWorkerPool.indexOf(worker)
    if (this.onWorkerUpdate) this.onWorkerUpdate({ type: "tool_worker", id: workerId, status: "busy", tool: toolName })

    return new Promise((resolve) => {
      this.toolResolvers.set(toolCallId, resolve)
      worker.postMessage({
        type: "TOOL_TASK",
        toolName,
        toolArgs,
        toolCallId,
        config,
      })
    })
  }

  /** Create a session at TUI startup — one session per TUI lifecycle */
  openSession(): string {
    this.activeSessionId = this.scribe.createSession(process.cwd())
    // Wire all shared subsystems against HiveDB-backed session state.
    const sessionState = { sessionId: this.activeSessionId }
    // Use a combined emitter: gateway broadcast + optional TUI socket callback
    const gatewayIpc = makeGatewayEmitter(this.activeSessionId)
    const onIpcEvent = this.onIpcEvent
    const ipc = onIpcEvent
      ? { emit(event: string, payload: unknown) { gatewayIpc.emit(event, payload); onIpcEvent(event, payload) } }
      : gatewayIpc
    this.initSubsystems(sessionState, this.activeSessionId, ipc)
    this.loadProjectAdrs(process.cwd())
    return this.activeSessionId
  }

  /** Close the session when TUI exits */
  closeSession(): void {
    if (this.activeSessionId) {
      this.scribe.closeSession(this.activeSessionId)
      this.activeSessionId = null
    }
  }

  getSessionId(): string | null {
    return this.activeSessionId
  }

  private emitTaskUpdate(status: string, extra: {
    title?: string
    mode?: string
    activeWorkers?: string[]
    workspace?: WorkspaceAssignment
    integrationStatus?: string
  } = {}): void {
    if (!this.activeTaskId) return
    const workspace = extra.workspace ?? this.taskWorkspaces.get(this.activeTaskId)
    this.onIpcEvent?.("task_update", {
      task_id: this.activeTaskId,
      title: extra.title,
      status,
      mode: extra.mode,
      active_workers: extra.activeWorkers,
      workspace_id: workspace?.workspaceId,
      workspace_path: workspace?.worktreePath,
      branch_name: workspace?.branchName,
      isolated: workspace?.isolated,
      integration_status: extra.integrationStatus,
    })
  }

  private getTaskWorkspace(taskId: string | null | undefined = this.activeTaskId): WorkspaceAssignment {
    const id = taskId || this.activeTaskId || "current"
    let workspace = this.taskWorkspaces.get(id)
    if (!workspace) {
      workspace = this.workspaceManager.createAssignment({
        taskId: id,
        projectPath: process.cwd(),
        mutating: false,
      })
      this.taskWorkspaces.set(id, workspace)
      this.taskSupervisor.assignWorkspace(id, {
        workspaceId: workspace.workspaceId,
        worktreePath: workspace.worktreePath,
        branchName: workspace.branchName,
      })
    }
    return workspace
  }

  private getTaskWorkspacePath(taskId: string | null | undefined = this.activeTaskId): string {
    return this.getTaskWorkspace(taskId).worktreePath
  }

  private async ensureTaskWorkspace(taskId: string, mutating: boolean): Promise<WorkspaceAssignment> {
    const existing = this.taskWorkspaces.get(taskId)
    if (existing && (!mutating || existing.isolated)) return existing

    const workspace = this.workspaceManager.createAssignment({
      taskId,
      projectPath: process.cwd(),
      mutating,
    })
    this.taskWorkspaces.set(taskId, workspace)
    this.taskSupervisor.markMutating(taskId, mutating)
    this.taskSupervisor.assignWorkspace(taskId, {
      workspaceId: workspace.workspaceId,
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
    })

    if (workspace.isolated && existsSync(workspace.worktreePath)) {
      // Deterministic task worktrees survive process restarts. Reattach instead
      // of attempting `git worktree add` over the existing directory.
      this.preparedWorkspaces.add(workspace.workspaceId)
    }
    if (workspace.isolated && !this.preparedWorkspaces.has(workspace.workspaceId)) {
      await this.workspaceManager.prepare(workspace)
      this.preparedWorkspaces.add(workspace.workspaceId)
      if (this.activeTaskId === taskId) {
        this.scribe.updateTaskStatus(taskId, "planning", { branchName: workspace.branchName })
        this.emitTaskUpdate("planning", { workspace, integrationStatus: "isolated" })
      }
      log.info(`[coordinator-manager] 🌿 Worktree created for ${taskId}: ${workspace.worktreePath}`)
    }

    return workspace
  }

  private logicalPath(filePath: string, workspacePath: string): string {
    if (!isAbsolute(filePath)) return filePath.replace(/\\/g, "/").replace(/^\.\//, "")
    const rel = relative(workspacePath, filePath)
    return rel.startsWith("..") || isAbsolute(rel) ? filePath : rel.replace(/\\/g, "/")
  }

  private workspacePath(filePath: string, workspacePath: string): string {
    return isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath)
  }

  private emitNarrativeChunk(chunk: {
    coordinator: string
    phase: string
    content: string
    streamId?: string
  }): void {
    this.onNarrativeChunk?.({
      ...chunk,
      taskId: this.activeTaskId ?? undefined,
      sessionId: this.activeSessionId ?? undefined,
    })
  }

  private createWorker(name: PhaseName): void {
    try {
      const worker = spawnCoordinatorWorker(name)
      worker.onmessage = (msg: MessageEvent) => this.handleWorkerMessage(name, msg.data as WorkerToManagerMessage)
      worker.onerror = (err: ErrorEvent) => {
        log.error(`[${name}] Worker crashed: ${err.message}. Restarting...`)
        // Write crash trace to code_traces for post-mortem analysis
        try {
          this.scribe.writeTrace({
            taskId: this.activeTaskId || "unknown",
            agentId: name,
            coordinator: name,
            toolName: "worker_crash",
            outputSummary: err.message,
            success: false,
            durationNs: 0,
          })
        } catch (traceErr) {
          log.warn(`[coordinator-manager] Failed to write crash trace: ${(traceErr as Error).message}`)
        }
        // Reject any in-flight resolver for this worker so dispatchPhase rejects immediately
        for (const [key, { reject }] of this.pendingResolvers) {
          if (key.startsWith(`${this.activeTaskId}:`) && key.includes(name)) {
            const timeout = this.pendingTimeouts.get(key)
            if (timeout) clearTimeout(timeout)
            this.pendingTimeouts.delete(key)
            this.pendingResolvers.delete(key)
            reject(new SystemError(`Worker ${name} crashed: ${err.message}`))
          }
        }
        this.workers.delete(name)
        // Auto-restart with real exponential backoff + circuit breaker: a worker
        // that crashes on every task (systematic bug) must not spin in a tight
        // restart loop — after MAX_WORKER_RESTARTS consecutive crashes we stop
        // restarting it and escalate instead of thrashing.
        const crashes = (this.workerCrashCounts.get(name) ?? 0) + 1
        this.workerCrashCounts.set(name, crashes)
        if (crashes > MAX_WORKER_RESTARTS) {
          log.error(
            `[coordinator-manager] ⛔ ${name} crashed ${crashes} times consecutively — ` +
            `circuit breaker open, not restarting. Escalating.`,
          )
          this.onIpcEvent?.("forensic_alert", {
            worker: name,
            reason: `${name} crashed ${crashes} times consecutively; auto-restart disabled.`,
            severity: "critical",
          })
          return
        }
        const delayMs = computeBackoffDelay(crashes, { initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30_000 })
        this.onIpcEvent?.("phase_retry", {
          worker: name,
          attempt: crashes,
          max_attempts: MAX_WORKER_RESTARTS,
          reason: `Crashed: ${err.message}. Restarting with backoff.`,
        })
        setTimeout(() => {
          this.createWorker(name)
          log.info(`[coordinator-manager] 🔄 ${name} worker restarted (attempt ${crashes}, ${Math.round(delayMs)}ms backoff)`)
        }, delayMs)
      }
      this.workers.set(name, worker)
      log.info(`[coordinator-manager] ✅ ${name} started`)
    } catch (err) {
      log.error(`[coordinator-manager] ❌ Failed to start ${name}: ${(err as Error).message}`)
    }
  }

  async stopAll(): Promise<void> {
    stopReflectorCron()
    for (const [name, worker] of this.workers) {
      worker.terminate()
      log.info(`[coordinator-manager] ${name} terminated`)
    }
    this.workers.clear()
    for (const worker of this.toolWorkerPool) worker.terminate()
    this.toolWorkerPool = []
    this.idleToolWorkers = []
    this.broadcastChannel?.close()
  }

  async runTask(
    description: string,
    mode?: SessionMode,
    onApprovalCheckpoint?: (ctx: {
      phase: string
      phaseIndex: number
      totalPhases: number
      narrativeEntry: string
      nextPhase?: string
    }) => Promise<"approve" | "skip" | "cancel">
  ): Promise<void> {
    mode = mode ?? getMode()

    // Ensure we have a session (created at TUI startup via openSession(), fallback here)
    if (!this.activeSessionId) {
      this.activeSessionId = this.scribe.createSession(process.cwd())
      const ipc = makeGatewayEmitter(this.activeSessionId)
      this.initSubsystems({ sessionId: this.activeSessionId }, this.activeSessionId, ipc)
      this.loadProjectAdrs(process.cwd())
    }

    // Create a turn for this user message — closed after we have the agent response
    const turnId = this.scribe.createTurn(this.activeSessionId, description)

    // Gather recent conversation history to give BEE context
    const recentTurns = this.scribe.getRecentTurns(this.activeSessionId, 10)
    const conversationHistory = recentTurns.map(t => ([
      { role: "user" as const,  content: t.userMessage,   createdAt: t.createdAt },
      { role: "agent" as const, content: t.agentResponse, createdAt: t.createdAt },
    ])).flat()

    this.activeTaskId = this.scribe.createTask(this.activeSessionId, description, mode)
    this.taskSupervisor.createTask({
      taskId: this.activeTaskId,
      sessionId: this.activeSessionId,
      title: description,
      stage: mode === "plan" ? "planning" : "understanding",
      executionPolicy: mode === "approval" ? "approval" : "auto",
    })
    const initialWorkspace = await this.ensureTaskWorkspace(
      this.activeTaskId,
      classifyTask(description) !== "conversation",
    )
    this.emitTaskUpdate("running", { title: description, mode })
    const taskStartTime = performance.now()

    // Resolve provider/model from HiveDB (set by REPL or provider add command)
    const configuredProvider = await getCodeConfig("default_provider")
    const configuredModel = configuredProvider
      ? await getCodeConfig(`provider_model_${configuredProvider}`)
      : ""

    log.info(`[coordinator-manager] 🚀 Task ${this.activeTaskId} (mode: ${mode}, provider: ${configuredProvider || "env-default"}): ${description}`)

    // Canonical profile harness. The old specialized coordinator pipeline is
    // retained below only to resume legacy plans when explicitly requested.
    if (process.env.HIVECODE_LEGACY_HARNESS !== "1") {
      const harness = new ProfileHarness()
      const result = await harness.run({
        objective: description,
        sessionId: this.activeSessionId,
        workspace: initialWorkspace.worktreePath,
        policy: mode,
        provider: configuredProvider || undefined,
        model: configuredModel || undefined,
        parentTaskId: this.activeTaskId,
        approve: onApprovalCheckpoint
          ? async (gate, evidence) => {
              const decision = await onApprovalCheckpoint({
                phase: gate,
                phaseIndex: gate === "specification" ? 1 : 2,
                totalPhases: 2,
                narrativeEntry: evidence,
                nextPhase: gate === "specification" ? "execute_dag" : "integrate",
              })
              return decision === "approve" ? "approve" : "cancel"
            }
          : undefined,
        onEvent: event => {
          if (event.agent) {
            if (event.type === "agent_progress") {
              this.emitNarrativeChunk({
                coordinator: event.agent,
                phase: event.phase ?? "progress",
                content: event.message,
                streamId: `${this.activeTaskId}:${event.agent}`,
              })
            }
            this.onIpcEvent?.("worker_update", {
              worker: event.agent,
              phase: event.phase ?? event.type,
              status: event.type === "agent_completed" ? "done" : "running",
              activity: event.message.slice(0, 160),
              task_id: this.activeTaskId,
            })
          }
        },
      })

      this.scribe.appendNarrative({
        taskId: this.activeTaskId,
        sessionId: this.activeSessionId,
        coordinator: "bee",
        phase: result.status,
        entry: result.response,
        isDraft: false,
        isOverride: false,
      })

      if (result.status === "completed") {
        if (result.complexity !== "conversation") {
          await this.integrateTaskWorkspace(this.activeTaskId, "auto")
        }
        this.scribe.updateTaskStatus(this.activeTaskId, "completed")
        this.taskSupervisor.updateStage(this.activeTaskId, "completed")
        this.emitTaskUpdate("completed", { title: description, mode })
      } else if (result.status === "ready" || result.status === "waiting_user") {
        this.scribe.updateTaskStatus(this.activeTaskId, "paused")
        this.taskSupervisor.updateStage(this.activeTaskId, "waiting_user")
        this.emitTaskUpdate("paused", { title: description, mode })
      } else {
        this.scribe.updateTaskStatus(this.activeTaskId, "cancelled")
        this.emitTaskUpdate("cancelled", { title: description, mode })
      }

      this.scribe.updateTaskMetadata(this.activeTaskId, {
        tokensIn: 0,
        tokensOut: 0,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        durationMs: Math.round(performance.now() - taskStartTime),
      })
      this.scribe.completeTurn(turnId, result.response, this.activeTaskId)
      if (this.onTaskComplete) this.onTaskComplete(result.response)
      if (result.response && !this.onTaskComplete) process.stdout.write(result.response + "\n")
      return
    }

    // ── Phase 0: BEE — Senior Dev orchestrator ────────────────────────────────
    // BEE reads project context, classifies the task, and decides how to route it.
    const beePhaseId = this.scribe.createPhase(this.activeTaskId, "bee", "bee")
    const beeTask: CoordinatorTask = {
      taskId: this.activeTaskId,
      phaseId: beePhaseId,
      phase: "bee",
      description,
      narrative: "",
      mode: mode ?? getMode(),
      projectPath: initialWorkspace.worktreePath,
      workspaceId: initialWorkspace.workspaceId,
      workspacePath: initialWorkspace.worktreePath,
      branchName: initialWorkspace.branchName,
      isolated: initialWorkspace.isolated,
      conversationHistory,
      secrets: this.secrets,
      provider: configuredProvider || undefined,
      model: configuredModel || undefined,
    }
    const beeResult = await this.dispatchPhase("bee", beeTask)

    // Parse BEE's decision — prefer structured decision from native tool call, fallback to legacy text parsing
    const beeDecision = beeResult.structuredDecision
      ? normalizeBeeDecision(beeResult.structuredDecision)
      : parseBeeDecision(beeResult.narrativeEntry)
    const beeNarrative = beeResult.status === "failed" || beeResult.status === "blocked"
      ? (beeResult.blockerDescription || beeResult.narrativeEntry || "")
      : formatBeeNarrative(beeDecision)

    if (beeResult.status === "failed" || beeResult.status === "blocked") {
      this.scribe.appendNarrative({
        taskId: this.activeTaskId,
        sessionId: this.activeSessionId!,
        coordinator: "bee",
        phase: "bee",
        entry: beeNarrative,
        isDraft: false,
        isOverride: false,
      })
      this.scribe.updatePhaseStatus(beePhaseId, beeResult.status, beeResult.blockerDescription)
      this.scribe.updateTaskStatus(this.activeTaskId, "failed")
      this.emitTaskUpdate("failed", { title: description, mode })
      const failMsg = beeResult.blockerDescription || "BEE failed"
      log.error(`[coordinator-manager] ❌ BEE phase failed: ${failMsg}`)
      throw new Error(failMsg)
    }

    this.scribe.appendNarrative({
      taskId: this.activeTaskId,
      sessionId: this.activeSessionId!,
      coordinator: "bee",
      phase: "bee",
      entry: beeNarrative,
      isDraft: false,
      isOverride: false,
    })
    this.scribe.updatePhaseStatus(beePhaseId, "completed", beeNarrative)
    this.scribe.updatePhaseMetadata(beePhaseId, beeResult.tokensIn ?? 0, beeResult.tokensOut ?? 0, beeResult.durationMs)
    log.info(`[coordinator-manager] 🐝 BEE decision: ${beeDecision.action} — ${beeDecision.reason}`)

    // Persist harness to narrative so CLI/UI can display it before execution
    if (beeDecision.harness && this.activeTaskId && this.activeSessionId) {
      this.scribe.appendNarrative({
        taskId: this.activeTaskId,
        sessionId: this.activeSessionId,
        coordinator: "bee",
        phase: "harness",
        entry: beeDecision.harness,
        isDraft: false,
        isOverride: false,
      })
      // Emit to live feed so Vite UI / TUI can render it immediately
      if (this.activeTaskId) broadcastNarrative(this.activeTaskId, {
        coordinator: "bee",
        phase: "harness",
        content: beeDecision.harness,
        timestamp: new Date().toISOString(),
      })
      // Parse "ARCHIVOS ESTIMADOS" section so the risk map shows estimated files in plan mode
      if (this.onIpcEvent) {
        for (const line of beeDecision.harness.split("\n")) {
          const newFile = line.match(/^\s+\+\s+(\S+)/)
          const modFile = line.match(/^\s+~\s+(\S+)/)
          if (newFile) {
            this.onIpcEvent("file_risk_update", { path: newFile[1], risk: "low", operation: "created", agent: "bee" })
          } else if (modFile) {
            this.onIpcEvent("file_risk_update", { path: modFile[1], risk: "medium", operation: "modified", agent: "bee" })
          }
        }
      }
    }

    // ── Route based on BEE's decision ─────────────────────────────────────────

    // RESPOND: BEE handled it directly — return the answer to the user.
    // This applies in all modes: a greeting or question never needs an architecture plan.
    if (beeDecision.action === "respond") {
      const response = beeDecision.content ?? ""
      this.scribe.updateTaskStatus(this.activeTaskId, "completed")
      this.emitTaskUpdate("completed", { title: description, mode })
      this.taskSupervisor.updateStage(this.activeTaskId, "completed")
      this.scribe.updateTaskMetadata(this.activeTaskId, {
        tokensIn: beeResult.tokensIn ?? 0, tokensOut: beeResult.tokensOut ?? 0,
        filesChanged: 0, linesAdded: 0, linesRemoved: 0,
        durationMs: Math.round(performance.now() - taskStartTime),
      })
      this.scribe.completeTurn(turnId, response, null)
      if (this.onTaskComplete) this.onTaskComplete(response)
      if (response && !this.onTaskComplete) process.stdout.write(response + "\n")
      return
    }

    // FIX: BEE applied a direct fix — report the summary and finish
    if (beeDecision.action === "fix" && mode !== "plan") {
      const response = beeDecision.content ?? ""
      const fileChanges: FileChange[] = (beeDecision.filesModified ?? []).map(f => ({
        filePath: f, changeType: "modified" as const, linesAdded: 0, linesRemoved: 0,
      }))
      if (fileChanges.length) this.scribe.writeFileChanges(this.activeTaskId, beePhaseId, fileChanges)
      const integrationState = await this.integrateTaskWorkspace(this.activeTaskId, mode, onApprovalCheckpoint)
      if (integrationState !== "completed") {
        this.scribe.completeTurn(turnId, response, this.activeTaskId)
        if (this.onTaskComplete) this.onTaskComplete(response)
        return
      }
      this.scribe.updateTaskStatus(this.activeTaskId, "completed")
      this.emitTaskUpdate("completed", { title: description, mode })
      this.taskSupervisor.updateStage(this.activeTaskId, "completed")
      this.scribe.updateTaskMetadata(this.activeTaskId, {
        tokensIn: beeResult.tokensIn ?? 0, tokensOut: beeResult.tokensOut ?? 0,
        filesChanged: fileChanges.length, linesAdded: 0, linesRemoved: 0,
        durationMs: Math.round(performance.now() - taskStartTime),
      })
      this.scribe.completeTurn(turnId, response, this.activeTaskId)
      if (this.onTaskComplete) this.onTaskComplete(response)
      if (response && !this.onTaskComplete) process.stdout.write(response + "\n")
      if (beeDecision.filesModified?.length) {
        log.info(`[coordinator-manager] 🐝 BEE modified: ${beeDecision.filesModified.join(", ")}`)
      }
      return
    }

    // DISPATCH: BEE decided which coordinators to use directly (no architecture phase)
    if (beeDecision.action === "dispatch" && beeDecision.phases?.length && mode !== "plan") {
      log.info(`[coordinator-manager] 🐝 BEE dispatching directly to: ${beeDecision.phases.map(p => p.coordinator).join(", ")}`)
      const dispatchPhases: ParsedPhase[] = beeDecision.phases.map(p => ({
        name: p.description,
        coordinator: p.coordinator as Exclude<PhaseName, "bee">,
        description: p.description,
        dependsOn: p.dependsOn as Array<Exclude<PhaseName, "bee">>,
      }))
      if (this.activeTaskId && this.phasesNeedIsolatedWorkspace(dispatchPhases)) {
        await this.ensureTaskWorkspace(this.activeTaskId, true)
      }
      const completed = await this.executePhaseLoop(
        dispatchPhases,
        description,
        beeResult.narrativeEntry,
        undefined,
        mode,
        configuredProvider,
        configuredModel,
        onApprovalCheckpoint,
      )
      if (!completed) return
      await this.finalizeTask(taskStartTime, turnId, "BEE dispatch completed", { mode, onApprovalCheckpoint })
      log.info(`[coordinator-manager] ✅ Task ${this.activeTaskId} completed (BEE dispatch)`)
      return
    }

    // ── Phase 1: ProductManager ───────────────────────────────────────────────
    // Architecture must not invent the "what". For tasks that need a design
    // plan, ProductManager first turns the request into a PRD/acceptance scope.
    const productWorkspace = this.getTaskWorkspace(this.activeTaskId)
    const productPhaseId = this.scribe.createPhase(this.activeTaskId, "product_manager", "product_manager")
    const productTask: CoordinatorTask = {
      taskId: this.activeTaskId,
      phaseId: productPhaseId,
      phase: "product_manager",
      description,
      narrative: beeResult.narrativeEntry,
      mode: mode ?? getMode(),
      projectPath: productWorkspace.worktreePath,
      workspaceId: productWorkspace.workspaceId,
      workspacePath: productWorkspace.worktreePath,
      branchName: productWorkspace.branchName,
      isolated: productWorkspace.isolated,
      secrets: this.secrets,
      provider: configuredProvider || undefined,
      model: configuredModel || undefined,
    }
    const productResult = await this.dispatchPhase("product_manager", productTask)

    if (productResult.status === "failed" || productResult.status === "blocked") {
      this.scribe.appendNarrative({
        taskId: this.activeTaskId,
        sessionId: this.activeSessionId!,
        coordinator: productResult.coordinator,
        phase: "product_manager",
        entry: productResult.narrativeEntry || productResult.blockerDescription || "",
        isDraft: false,
        isOverride: false,
      })
      this.scribe.updatePhaseStatus(productPhaseId, productResult.status, productResult.blockerDescription)
      this.scribe.updateTaskStatus(this.activeTaskId, "failed")
      const failMsg = productResult.blockerDescription || "ProductManager coordinator failed"
      log.error(`[coordinator-manager] ❌ ProductManager phase failed: ${failMsg}`)
      throw new Error(failMsg)
    }

    const productNarrative = productResult.narrativeEntry || ""
    this.scribe.appendNarrative({
      taskId: this.activeTaskId,
      sessionId: this.activeSessionId!,
      coordinator: productResult.coordinator,
      phase: "product_manager",
      entry: productNarrative,
      isDraft: false,
      isOverride: false,
    })
    this.scribe.updatePhaseStatus(productPhaseId, "completed", productNarrative)
    this.scribe.updatePhaseMetadata(productPhaseId, productResult.tokensIn ?? 0, productResult.tokensOut ?? 0, productResult.durationMs)

    // ── Phase 2: Architecture ─────────────────────────────────────────────────
    // Architecture is read-only and starts from ProductManager's PRD. Mutating
    // implementation phases get an isolated worktree after the plan is parsed.
    const architectureWorkspace = this.getTaskWorkspace(this.activeTaskId)
    const archPhaseId = this.scribe.createPhase(this.activeTaskId, "architecture", "architecture")
    const architectureNarrative = [
      "BEE decision:",
      beeResult.narrativeEntry,
      "",
      "ProductManager PRD:",
      productNarrative,
    ].join("\n")
    const archTask: CoordinatorTask = {
      taskId: this.activeTaskId,
      phaseId: archPhaseId,
      phase: "architecture",
      description,
      narrative: architectureNarrative,
      mode: mode ?? getMode(),
      projectPath: architectureWorkspace.worktreePath,
      workspaceId: architectureWorkspace.workspaceId,
      workspacePath: architectureWorkspace.worktreePath,
      branchName: architectureWorkspace.branchName,
      isolated: architectureWorkspace.isolated,
      secrets: this.secrets,
      provider: configuredProvider || undefined,
      model: configuredModel || undefined,
    }
    const archResult = await this.dispatchPhase("architecture", archTask)

    if (archResult.status === "failed" || archResult.status === "blocked") {
      this.scribe.appendNarrative({
        taskId: this.activeTaskId,
        sessionId: this.activeSessionId!,
        coordinator: archResult.coordinator,
        phase: "architecture",
        entry: archResult.narrativeEntry || archResult.blockerDescription || "",
        isDraft: false,
        isOverride: false,
      })
      this.scribe.updatePhaseStatus(archPhaseId, archResult.status, archResult.blockerDescription)
      this.scribe.updateTaskStatus(this.activeTaskId, "failed")
      const failMsg = archResult.blockerDescription || "Architecture coordinator failed"
      log.error(`[coordinator-manager] ❌ Architecture phase failed: ${failMsg}`)
      throw new Error(failMsg)
    }

    this.scribe.appendNarrative({
      taskId: this.activeTaskId,
      sessionId: this.activeSessionId!,
      coordinator: archResult.coordinator,
      phase: "architecture",
      entry: archResult.narrativeEntry,
      isDraft: false,
      isOverride: false,
    })
    this.scribe.updatePhaseStatus(archPhaseId, "completed", archResult.narrativeEntry)

    // Parse the architecture output into a structured plan — prefer structured decision from native tool call
    const plan = archResult.structuredDecision
      ? parsePlan(archResult.structuredDecision)
      : parsePlan(archResult.narrativeEntry)
    if (mode === "plan") {
      const incompleteReason = plan.parseError
        ?? (!plan.adr.title.trim() || plan.adr.title === "Untitled ADR"
          ? "Architecture no produjo el titulo del ADR."
          : !plan.adr.context.trim() || !plan.adr.decision.trim()
            ? "Architecture no produjo contexto y decision completos para el ADR."
            : plan.phases.length === 0
              ? "Architecture no produjo fases de implementacion."
              : undefined)
      if (incompleteReason) {
        this.scribe.updateTaskStatus(this.activeTaskId, "failed")
        const failMsg = `No se pudo generar un plan aprobable: ${incompleteReason}`
        log.error(`[coordinator-manager] ${failMsg}`)
        throw new Error(failMsg)
      }
    }

    // Send structured plan to TUI
    if (this.onIpcEvent) {
      const groupedPhases = groupPhasesByLevel(plan.phases)
      const phasesWithLevel = plan.phases.map((p, idx) => ({
        name: p.name,
        coordinator: p.coordinator,
        description: p.description,
        depends_on: p.dependsOn,
        level: groupedPhases.findIndex(g => g.some(gp => gp.name === p.name && gp.coordinator === p.coordinator)),
        status: "pending" as string,
      }))
      this.onIpcEvent("plan_update", {
        task_id: this.activeTaskId,
        adr_title: plan.adr.title,
        adr_content: [
          plan.adr.context,
          plan.adr.options,
          plan.adr.decision,
          plan.adr.consequences,
        ].filter(Boolean).join("\n\n"),
        status: "pending",
        phases: phasesWithLevel,
        risks: plan.risks,
      })
    }

    // Save ADR to database
    if (plan.adr.title) {
      this.scribe.writeDecision({
        id: Bun.randomUUIDv7(),
        taskId: this.activeTaskId,
        title: plan.adr.title,
        context: plan.adr.context,
        options: plan.adr.options,
        decision: plan.adr.decision,
        consequences: plan.adr.consequences,
        status: "active",
      })
      log.info(`[coordinator-manager] 📝 ADR saved: ${plan.adr.title}`)
    }

    // Log risks
    for (const risk of plan.risks) {
      log.warn(`[coordinator-manager] ⚠️  Risk [${risk.severity}]: ${risk.description}`)
    }

    if (mode === "plan") {
      // Print ADR to stdout so the TUI / executeTask captures it
      const lines: string[] = []
      if (plan.adr.title)        lines.push(`\n## ${plan.adr.title}\n`)
      if (plan.adr.context)      lines.push(`**Contexto:** ${plan.adr.context}\n`)
      if (plan.adr.decision)     lines.push(`**Decisión:** ${plan.adr.decision}\n`)
      if (plan.adr.consequences) lines.push(`**Consecuencias:** ${plan.adr.consequences}\n`)
      if (plan.phases.length)    lines.push(`\n**Fases:** ${plan.phases.map(p => p.coordinator).join(" → ")}\n`)
      if (plan.risks.length)     lines.push(`\n**Riesgos:**\n${plan.risks.map(r => `- [${r.severity}] ${r.description}`).join("\n")}\n`)
      const adrText = lines.join("")
      // In callback-driven TUI sessions the plan is delivered via IPC/state;
      // writing it to inherited stdout paints raw text over the alternate screen.
      if (adrText && !this.onTaskComplete) process.stdout.write(adrText)

      await this.finalizeTask(taskStartTime, turnId, adrText || archResult.narrativeEntry)
      return
    }

    // Execute dynamic phases from the architecture plan
    const phases = plan.phases.length > 0 ? plan.phases : getDefaultPhases()
    if (this.activeTaskId && this.phasesNeedIsolatedWorkspace(phases)) {
      await this.ensureTaskWorkspace(this.activeTaskId, true)
    }
    const completed = await this.executePhaseLoop(
      phases,
      description,
      archResult.narrativeEntry,
      plan.interfaces,
      mode,
      configuredProvider,
      configuredModel,
      onApprovalCheckpoint,
    )
    if (!completed) return

    await this.finalizeTask(taskStartTime, turnId, archResult.narrativeEntry, { mode, onApprovalCheckpoint })
    log.info(`[coordinator-manager] ✅ Task ${this.activeTaskId} completed`)
  }

  /** Persist task-level metadata (tokens, files, duration) and close the turn */
  private async finalizeTask(
    taskStartMs: number,
    turnId: string,
    agentResponse: string,
    options: {
      mode?: SessionMode
      onApprovalCheckpoint?: (ctx: {
        phase: string
        phaseIndex: number
        totalPhases: number
        narrativeEntry: string
        nextPhase?: string
      }) => Promise<"approve" | "skip" | "cancel">
    } = {},
  ): Promise<void> {
    if (!this.activeTaskId) return
    const taskId = this.activeTaskId
    const workspace = this.getTaskWorkspace(taskId)
    const workspaceRoot = workspace.worktreePath
    const durationMs = Math.round(performance.now() - taskStartMs)

    // Aggregate tokens from all phases.
    const phaseRows = await (await col<CodeTaskPhaseDoc>("codeTaskPhases")).findBy("task_id", this.activeTaskId)
    const totals = phaseRows.reduce((acc, entry) => ({
      ti: acc.ti + entry.doc.tokens_in,
      tout: acc.tout + entry.doc.tokens_out,
    }), { ti: 0, tout: 0 })

    // Collect git changes after task
    let fileChanges: FileChange[] = []
    try {
      const gitStat = await executeToolByName(this.allTools, "git_status", { path: workspaceRoot }, { configurable: { workspace: workspaceRoot } }) as any
      const statusResult = gitStat?.result ?? gitStat
      const changedFiles: string[] = [
        ...(statusResult?.staged ?? []),
        ...(statusResult?.unstaged ?? []),
      ].filter((v, i, a) => a.indexOf(v) === i)

      // Parse git diff --stat for line counts
      const diffStat = await executeToolByName(this.allTools, "git_diff", {
        path: workspaceRoot, stat: true,
      }, { configurable: { workspace: workspaceRoot } }) as any
      const diffResult = diffStat?.result ?? diffStat
      const diffText: string = diffResult?.diff ?? ""
      const lineStats = parseGitDiffStat(diffText)

      fileChanges = changedFiles.map(f => ({
        filePath: f,
        changeType: "modified" as const,
        linesAdded: lineStats[f]?.added ?? 0,
        linesRemoved: lineStats[f]?.removed ?? 0,
      }))

      if (fileChanges.length) {
        this.scribe.writeFileChanges(this.activeTaskId, null, fileChanges)
      }
    } catch (gitErr) {
      log.debug(`[coordinator-manager] git tools unavailable: ${(gitErr as Error).message}`)
    }

    const linesAdded   = fileChanges.reduce((s, f) => s + f.linesAdded,   0)
    const linesRemoved = fileChanges.reduce((s, f) => s + f.linesRemoved, 0)

    this.scribe.updateTaskMetadata(this.activeTaskId, {
      tokensIn:     totals.ti,
      tokensOut:    totals.tout,
      filesChanged: fileChanges.length,
      linesAdded,
      linesRemoved,
      durationMs,
    })
    // Learning Harness — evaluate phases before marking completed
    try {
      const taskEval = this.scribe.evaluateTaskPhases(taskId)
      if (taskEval.hasFailures) {
        const patterns = this.scribe.getFailurePatterns({ minOccurrences: 1 })
        if (patterns.length > 0 && taskEval.frictionPhase) {
          this.scribe.writeProposal({
            sourceAgent: "bee",
            proposalType: "prompt_change",
            description: `Fase "${taskEval.frictionPhase}" tuvo fricción en tarea ${taskId}. ${taskEval.failureSummary}`,
            failureIds: patterns.flatMap(p => p.ids),
          })
        }
      }
    } catch (evalErr) {
      log.warn(`[coordinator-manager] Learning harness evaluation failed: ${(evalErr as Error).message}`)
    }

    const integrationState = await this.integrateTaskWorkspace(taskId, options.mode, options.onApprovalCheckpoint)
    if (integrationState !== "completed") {
      this.scribe.completeTurn(turnId, agentResponse, taskId)
      if (this.onTaskComplete) this.onTaskComplete(agentResponse)
      return
    }

    this.scribe.updateTaskStatus(taskId, "completed")
    this.emitTaskUpdate("completed")
    this.taskSupervisor.updateStage(taskId, "completed")
    this.scribe.completeTurn(turnId, agentResponse, taskId)

    if (this.onTaskComplete) {
      this.onTaskComplete(agentResponse)
    }

    broadcastTaskEnd(taskId, "completed", durationMs)

    // ACE Reflector: auto-run every N tasks or when trace threshold is met
    incrementTaskCounter()
    if (shouldRunReflector()) {
      runReflector().then((result) => {
        if (result.rules > 0) {
          log.info(`[coordinator-manager] ACE Reflector auto-run: ${result.rules} new rules`)
        }
      }).catch((err) => {
        log.warn("[coordinator-manager] ACE Reflector auto-run failed:", (err as Error).message)
      })
    }
  }

  private phasesNeedIsolatedWorkspace(phases: ParsedPhase[]): boolean {
    const mutatingCoordinators = new Set<PhaseName>([
      "backend", "frontend", "data_scientist", "devops",
    ])
    return phases.some((phase) => mutatingCoordinators.has(phase.coordinator))
  }

  private async integrateTaskWorkspace(
    taskId: string,
    mode?: SessionMode,
    onApprovalCheckpoint?: (ctx: {
      phase: string
      phaseIndex: number
      totalPhases: number
      narrativeEntry: string
      nextPhase?: string
    }) => Promise<"approve" | "skip" | "cancel">,
  ): Promise<"completed" | "paused" | "cancelled"> {
    const workspace = this.taskWorkspaces.get(taskId)
    if (!workspace?.isolated) return "completed"

    this.taskSupervisor.updateStage(taskId, "integrating")
    this.emitTaskUpdate("integrating", { workspace, integrationStatus: "diff" })

    let diff = ""
    try {
      diff = await this.workspaceManager.diff(workspace)
    } catch (err) {
      const errorMsg = `[WORKTREE] Could not diff ${workspace.worktreePath}: ${(err as Error).message}`
      this.scribe.updateTaskStatus(taskId, "paused")
      this.emitTaskUpdate("paused", { workspace, integrationStatus: "failed" })
      this.onIpcEvent?.("conflict_alert", {
        agent_a: "integration",
        agent_b: "workspace",
        file: workspace.worktreePath,
        reason: "worktree diff failed",
        severity: "high",
        detail: errorMsg,
      })
      return "paused"
    }

    if (mode === "approval" && onApprovalCheckpoint && diff.trim()) {
      const decision = await onApprovalCheckpoint({
        phase: "integration",
        phaseIndex: 0,
        totalPhases: 1,
        narrativeEntry: smartTruncateLines(diff, 200),
      })
      if (decision === "cancel") {
        this.scribe.updateTaskStatus(taskId, "cancelled")
        this.emitTaskUpdate("cancelled", { workspace, integrationStatus: "cancelled" })
        return "cancelled"
      }
      if (decision === "skip") {
        this.scribe.updateTaskStatus(taskId, "paused")
        this.emitTaskUpdate("paused", { workspace, integrationStatus: "skipped" })
        return "paused"
      }
    }

    const result = await this.workspaceManager.integrate(workspace)
    if (result.status === "conflict" || result.status === "failed") {
      const errorMsg = result.error || "unknown integration failure"
      this.scribe.updateTaskStatus(taskId, "paused")
      this.emitTaskUpdate("paused", { workspace, integrationStatus: result.status })
      this.onIpcEvent?.("conflict_alert", {
        agent_a: "integration",
        agent_b: "workspace",
        file: workspace.worktreePath,
        reason: `worktree ${result.status}`,
        severity: result.status === "conflict" ? "critical" : "high",
        detail: errorMsg,
      })
      log.warn(`[coordinator-manager] ⚠️ Worktree integration ${result.status}: ${errorMsg}`)
      return "paused"
    }

    try {
      await this.workspaceManager.cleanup(workspace)
      this.preparedWorkspaces.delete(workspace.workspaceId)
    } catch (err) {
      log.warn(`[coordinator-manager] ⚠️ Worktree cleanup failed: ${(err as Error).message}`)
    }

    this.emitTaskUpdate("integrating", { workspace, integrationStatus: result.status })
    return "completed"
  }

  private async cleanupTaskWorkspaceIfClean(taskId: string, status = "paused"): Promise<void> {
    const workspace = this.taskWorkspaces.get(taskId)
    if (!workspace?.isolated) return

    try {
      const diff = await this.workspaceManager.diff(workspace)
      if (diff.trim()) {
        this.emitTaskUpdate(status, { workspace, integrationStatus: "retained" })
        return
      }
      await this.workspaceManager.cleanup(workspace)
      this.preparedWorkspaces.delete(workspace.workspaceId)
      this.emitTaskUpdate(status, { workspace, integrationStatus: "discarded" })
    } catch (err) {
      log.warn(`[coordinator-manager] ⚠️ Clean workspace cleanup failed: ${(err as Error).message}`)
    }
  }

  /** Execute a list of phases grouped by dependency level.
   *  Used both by the Architecture path and BEE's direct dispatch. */
  private async executePhaseLoop(
    phases: ParsedPhase[],
    description: string,
    archNarrative: string | undefined,
    interfaces: string | undefined,
    mode: SessionMode,
    provider: string,
    model: string,
    onApprovalCheckpoint?: (ctx: {
      phase: string
      phaseIndex: number
      totalPhases: number
      narrativeEntry: string
      nextPhase?: string
    }) => Promise<"approve" | "skip" | "cancel">,
    startLevel = 0,
  ): Promise<boolean> {
    const levels = groupPhasesByLevel(phases)

    // Persist the plan so a later process can resume this task from a recovery
    // point instead of restarting from scratch (see resumeTask).
    if (this.activeTaskId) {
      this.scribe.savePlan(this.activeTaskId, {
        phases,
        description,
        provider,
        model,
        archNarrative: archNarrative ?? null,
        interfaces: interfaces ?? null,
        mode,
      })
    }

    log.info(`[coordinator-manager] 📋 Executing ${phases.length} phases in ${levels.length} level(s)${startLevel > 0 ? ` (resuming at level ${startLevel})` : ""}:`)
    for (let lvl = 0; lvl < levels.length; lvl++) {
      log.info(`[coordinator-manager]    Level ${lvl}: ${levels[lvl].map(p => p.coordinator).join(" + ")}`)
    }

    let globalPhaseIndex = 0

    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      // Resume: levels below startLevel already completed in a prior run.
      if (levelIdx < startLevel) {
        globalPhaseIndex += levels[levelIdx].length
        continue
      }

      if (isCancelled()) {
        if (this.activeTaskId) await this.cleanupTaskWorkspaceIfClean(this.activeTaskId, "cancelled")
        return false
      }

      // Track current level for worker activity writes.
      this.currentLevel = levelIdx

      const phaseMode = getMode()
      const levelPhases = levels[levelIdx]

      if (phaseMode === "plan") {
        log.info(`[coordinator-manager] 📋 Switched to plan — skipping level ${levelIdx}`)
        globalPhaseIndex += levelPhases.length
        continue
      }

      // Recovery checkpoint: save progress before dispatching each level
      if (this.activeTaskId) {
        const completedPhaseIds = levels
          .slice(0, levelIdx)
          .flat()
          .map((_, i) => i)
        const pendingPhaseIds = levels
          .slice(levelIdx)
          .flat()
          .map((_, i) => levelIdx + i)
        this.scribe.saveRecoveryPoint(this.activeTaskId, null, completedPhaseIds, pendingPhaseIds, levelIdx)
      }

      const levelTasks: Array<{ phase: PhaseName; task: CoordinatorTask; startedAt: number }> = []
      for (const phaseDef of levelPhases) {
        const phase = phaseDef.coordinator
        const workspace = this.getTaskWorkspace(this.activeTaskId)
        // Override model to most capable for reviewer
        const effectiveModel = phase === "reviewer" ? (await this.getHighestCapabilityModel()) || model : model
        const task: CoordinatorTask = {
          taskId: this.activeTaskId || "current",
          phaseId: this.scribe.createPhase(this.activeTaskId || "current", phase, phase),
          phase,
          description,
          adr: archNarrative,
          interfaces,
          narrative: archNarrative || "",
          mode: phaseMode,
          projectPath: workspace.worktreePath,
          workspaceId: workspace.workspaceId,
          workspacePath: workspace.worktreePath,
          branchName: workspace.branchName,
          isolated: workspace.isolated,
          secrets: this.secrets,
          provider: provider || undefined,
          model: effectiveModel || undefined,
        }
        this.writeWorkerActivity(phase, levelIdx, "running", 0, 0, Date.now(), null)
        levelTasks.push({ phase, task, startedAt: Date.now() })
      }

      // Transversal SecurityAuditor: run alongside engineer levels if security is not already planned
      const engineerPhases: PhaseName[] = ["backend", "frontend", "data_scientist"]
      const levelHasEngineers = levelPhases.some(p => engineerPhases.includes(p.coordinator))
      const securityAlreadyInLevel = levelPhases.some(p => p.coordinator === "security")
      if (levelHasEngineers && !securityAlreadyInLevel) {
        const workspace = this.getTaskWorkspace(this.activeTaskId)
        const secTask: CoordinatorTask = {
          taskId: this.activeTaskId || "current",
          phaseId: this.scribe.createPhase(this.activeTaskId || "current", "security", "security"),
          phase: "security",
          description: `[TRANSVERSAL WATCH] Review code being written by engineers in level ${levelIdx} for critical security issues. Report CRITICAL findings immediately.`,
          adr: archNarrative,
          interfaces,
          narrative: archNarrative || "",
          mode: phaseMode,
          projectPath: workspace.worktreePath,
          workspaceId: workspace.workspaceId,
          workspacePath: workspace.worktreePath,
          branchName: workspace.branchName,
          isolated: workspace.isolated,
          secrets: this.secrets,
          provider: provider || undefined,
          model: model || undefined,
        }
        this.writeWorkerActivity("security", levelIdx, "running", 0, 0, Date.now(), null)
        levelTasks.push({ phase: "security", task: secTask, startedAt: Date.now() })
      }

      // Announce phase start to live feed
      for (const { phase } of levelTasks) {
        if (this.activeTaskId) broadcastPhaseStart(this.activeTaskId, phase, phase)
      }

      const results: CoordinatorResult[] = []
      // Global adaptive ceiling: never keep more than three model invocations
      // active, even when a legacy plan emits a wider dependency level.
      for (let offset = 0; offset < levelTasks.length; offset += 3) {
        const batch = levelTasks.slice(offset, offset + 3)
        results.push(...await Promise.all(
          batch.map(({ phase, task }) => this.dispatchPhase(phase, task)),
        ))
      }

      for (let r = 0; r < results.length; r++) {
        const result = results[r]
        const { phase, task, startedAt } = levelTasks[r]

        // Record completion in worker activity.
        this.writeWorkerActivity(
          phase, levelIdx,
          result.status === "failed" ? "failed" : "done",
          result.tokensIn ?? 0, result.tokensOut ?? 0,
          startedAt, Date.now()
        )

        this.scribe.appendNarrative({
          taskId: this.activeTaskId!,
          sessionId: this.activeSessionId!,
          coordinator: result.coordinator,
          phase,
          entry: result.narrativeEntry || result.blockerDescription || "",
          isDraft: false,
          isOverride: false,
        })

        if (result.status === "failed" && result.iterationLimitReached) {
          log.warn(`[coordinator-manager] ⚠️ ${phase} hit iteration limit — invoking ForensicAgent`)
          const forensicResult = await this.runForensicAgent(phase, task, result)
          const recommendation = this.parseForensicRecommendation(forensicResult.narrativeEntry)

          if (recommendation.action === "escalate") {
            this.scribe.updateTaskStatus(this.activeTaskId!, "paused")
            log.warn(`[coordinator-manager] 🚨 ForensicAgent escalation: ${recommendation.detail}`)
            if (this.onIpcEvent) {
              this.onIpcEvent("forensic_alert", { worker: phase, analysis: forensicResult.narrativeEntry, recommendation: recommendation.detail })
            }
            await this.cleanupTaskWorkspaceIfClean(this.activeTaskId!, "paused")
            return false
          }

          if (recommendation.action === "retry_with_constraint") {
            log.info(`[coordinator-manager] 🔄 Retrying ${phase} with constraint: ${recommendation.detail}`)
            const constraintTask: CoordinatorTask = {
              ...task,
              phaseId: this.scribe.createPhase(this.activeTaskId || "current", phase, phase),
              narrative: (archNarrative || "") + `\n\nCONSTRAINT (ForensicAgent): ${recommendation.detail}`,
            }
            this.writeWorkerActivity(phase, levelIdx, "running", 0, 0, Date.now(), null)
            const retryResult = await this.dispatchPhase(phase, constraintTask)
            this.writeWorkerActivity(
              phase, levelIdx,
              retryResult.status === "failed" ? "failed" : "done",
              retryResult.tokensIn ?? 0, retryResult.tokensOut ?? 0,
              Date.now(), Date.now()
            )
            if (retryResult.status === "failed") {
              this.scribe.updateTaskStatus(this.activeTaskId!, "failed")
              log.error(`[coordinator-manager] ❌ ${phase} failed after ForensicAgent retry`)
              await this.cleanupTaskWorkspaceIfClean(this.activeTaskId!, "failed")
              return false
            }
            this.scribe.updatePhaseStatus(constraintTask.phaseId, "completed", retryResult.narrativeEntry)
            this.scribe.updatePhaseMetadata(constraintTask.phaseId, retryResult.tokensIn ?? 0, retryResult.tokensOut ?? 0, retryResult.durationMs)
            continue
          }

          // Reasign: handle as regular failure
          this.scribe.updateTaskStatus(this.activeTaskId!, "failed")
          log.error(`[coordinator-manager] ❌ ${phase} phase failed (ForensicAgent recommends reasign)`)
          await this.cleanupTaskWorkspaceIfClean(this.activeTaskId!, "failed")
          return false
        }

        if (result.status === "failed") {
          this.scribe.updateTaskStatus(this.activeTaskId!, "failed")
          log.error(`[coordinator-manager] ❌ ${phase} phase failed: ${result.blockerDescription}`)
          // Learning Harness — capture phase failure (fire-and-forget)
          try {
            this.scribe.writeFailure({
              taskId: this.activeTaskId!,
              phaseId: null,
              agent: phase,
              failureType: "phase_failure",
              errorMessage: result.blockerDescription ?? "unknown",
            })
          } catch (writeErr) {
            log.warn(`[coordinator-manager] Failed to write learning failure: ${(writeErr as Error).message}`)
          }
          await this.cleanupTaskWorkspaceIfClean(this.activeTaskId!, "failed")
          return false
        }

        if (result.status === "blocked") {
          this.scribe.updatePhaseStatus(task.phaseId, "blocked", result.blockerDescription)
          this.scribe.updateTaskStatus(this.activeTaskId!, "paused")
          log.warn(`[coordinator-manager] ⚠️ ${phase} phase blocked: ${result.blockerDescription}`)
          await this.cleanupTaskWorkspaceIfClean(this.activeTaskId!, "paused")
          return false
        }

        this.scribe.updatePhaseStatus(task.phaseId, "completed", result.narrativeEntry)
        this.scribe.updatePhaseMetadata(task.phaseId, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs)

        if (this.activeTaskId) {
          broadcastPhase(this.activeTaskId, {
            name: phase,
            status: "completed",
            coordinator: phase,
            durationMs: result.durationMs,
          })
          broadcastPhaseEnd(this.activeTaskId, phase, phase, result.durationMs)
        }

        // Post-reviewer: activate Librarian if approved
        if (phase === "reviewer") {
          const structuredVerdict = result.structuredDecision as unknown as ReviewVerdict | undefined
          const verdict = structuredVerdict?.verdict ?? this.parseReviewerVerdict(result.narrativeEntry)
          if (structuredVerdict) {
            const unmet = structuredVerdict.criteria.filter((c) => !c.met)
            this.onIpcEvent?.("review_verdict_update", {
              reviewer: "reviewer",
              status: structuredVerdict.verdict,
              summary: structuredVerdict.reasons
                || (unmet.length > 0
                  ? `${unmet.length}/${structuredVerdict.criteria.length} criterios sin cumplir`
                  : `${structuredVerdict.criteria.length}/${structuredVerdict.criteria.length} criterios cumplidos`),
              observations: (structuredVerdict.categories ?? []).map((c) => `[${c.status}] ${c.name}${c.detail ? `: ${c.detail}` : ""}`),
              requested_changes: unmet.map((c) => c.description),
              affected_files: [],
              criteria: structuredVerdict.criteria,
              categories: structuredVerdict.categories,
            })
          }
          if (verdict === "aprobado" || verdict === "aprobado_con_observaciones") {
            log.info(`[coordinator-manager] 📚 Reviewer approved — activating Librarian`)
            this.runLibrarianAgent(task, provider, model).catch(err => {
              log.warn(`[coordinator-manager] Librarian error: ${(err as Error).message}`)
            })
          } else {
            log.info(`[coordinator-manager] 🔄 Reviewer rejected — marking task for retry`)
            this.scribe.updateTaskStatus(this.activeTaskId!, "failed")
            return false
          }
        }
      }

      const nextLevelPhases = levels[levelIdx + 1]
      if (phaseMode === "approval" && onApprovalCheckpoint && nextLevelPhases) {
        log.info(`[coordinator-manager] 🟡 Level ${levelIdx} awaiting approval`)

        const decision = await onApprovalCheckpoint({
          phase: levelPhases.map(p => p.coordinator).join(", "),
          phaseIndex: globalPhaseIndex,
          totalPhases: phases.length,
          narrativeEntry: results.map(r => r.narrativeEntry).join("\n\n"),
          nextPhase: nextLevelPhases.map(p => p.coordinator).join(", "),
        })

        if (decision === "cancel") {
          this.scribe.updateTaskStatus(this.activeTaskId!, "cancelled")
          this.emitTaskUpdate("cancelled")
          log.info(`[coordinator-manager] ❌ Task cancelled by user at level ${levelIdx}`)
          await this.cleanupTaskWorkspaceIfClean(this.activeTaskId!, "cancelled")
          return false
        }

        if (decision === "skip") {
          for (const { task } of levelTasks) {
            this.scribe.updatePhaseStatus(task.phaseId, "skipped")
          }
          log.info(`[coordinator-manager] ⏭️  Skipped level ${levelIdx}`)
          globalPhaseIndex += levelPhases.length
          continue
        }

        log.info(`[coordinator-manager] ✅ Level ${levelIdx} approved`)
      }

      globalPhaseIndex += levelPhases.length
    }
    return true
  }

  /**
   * Re-enter a task's phase loop from its latest recovery point instead of
   * restarting from BEE. Needs a persisted plan (savePlan, written when the loop
   * first ran) — tasks that predate plan persistence can't be resumed this way
   * and the caller should re-run them normally. Returns true if the task
   * completed. Surfaced via the CLI `task resume` command and the boot-time
   * `resume_available` signal.
   */
  async resumeTask(taskId: string): Promise<boolean> {
    const profileTask = (await (await col<HarnessTaskDoc>("harnessTasks")).scan())
      .map(entry => entry.doc)
      .filter(task => task.parentTaskId === taskId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (profileTask) {
      this.activeTaskId = taskId
      if (!this.activeSessionId) this.activeSessionId = profileTask.sessionId
      const workspace = await this.ensureTaskWorkspace(taskId, profileTask.mutating)
      const configuredProvider = await getCodeConfig("default_provider")
      const configuredModel = configuredProvider
        ? await getCodeConfig(`provider_model_${configuredProvider}`)
        : ""
      const result = await new ProfileHarness().run({
        objective: profileTask.title,
        sessionId: profileTask.sessionId,
        workspace: workspace.worktreePath,
        policy: profileTask.executionPolicy,
        provider: configuredProvider || undefined,
        model: configuredModel || undefined,
        resumeTaskId: profileTask.taskId,
        parentTaskId: taskId,
        // `task resume` already asks the operator for explicit confirmation.
        approve: async () => "approve",
      })
      if (result.status === "completed") {
        if (result.complexity !== "conversation") {
          await this.integrateTaskWorkspace(taskId, "auto")
        }
        this.scribe.updateTaskStatus(taskId, "completed")
        this.emitTaskUpdate("completed")
        return true
      }
      this.scribe.updateTaskStatus(taskId, "paused")
      this.emitTaskUpdate("paused")
      return false
    }

    const plan = await this.scribe.getPlan(taskId)
    if (!plan) {
      log.warn(`[coordinator-manager] ✗ Cannot resume ${taskId}: no persisted plan`)
      return false
    }
    const recovery = this.scribe.getLatestRecoveryPoint(taskId)
    const startLevel = recovery?.level ?? 0
    const phases = JSON.parse(plan.phases_json) as ParsedPhase[]

    this.activeTaskId = taskId
    if (!this.activeSessionId) this.activeSessionId = this.scribe.createSession(process.cwd())
    const turnId = this.scribe.createTurn(this.activeSessionId, `Resume task ${taskId}`)
    this.scribe.updateTaskStatus(taskId, "running")
    log.info(`[coordinator-manager] ▶️  Resuming task ${taskId} at level ${startLevel} (${phases.length} phase(s) in plan)`)

    const taskStartMs = performance.now()
    const completed = await this.executePhaseLoop(
      phases,
      plan.description,
      plan.arch_narrative ?? undefined,
      plan.interfaces ?? undefined,
      plan.mode as SessionMode,
      plan.provider,
      plan.model,
      undefined,
      startLevel,
    )
    if (completed) {
      await this.finalizeTask(taskStartMs, turnId, "Task resumed and completed", { mode: plan.mode as SessionMode })
      log.info(`[coordinator-manager] ✅ Resumed task ${taskId} completed`)
    }
    return completed
  }

  /** Write worker activity for level-based tracking. */
  private writeWorkerActivity(
    phase: PhaseName,
    level: number,
    status: "running" | "done" | "failed",
    tokensIn: number,
    tokensOut: number,
    startedAt: number | null,
    completedAt: number | null
  ): void {
    if (!this.activeSessionId) return
    try {
      void this.persistWorkerActivity({
        id: `wa_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        session_id: this.activeSessionId,
        worker: phase,
        phase,
        level,
        status,
        current_action: status === "running" ? `ejecutando ${phase}` : phase,
        input_tokens: tokensIn,
        output_tokens: tokensOut,
        started_at: startedAt,
        completed_at: completedAt,
      })
      this.onIpcEvent?.("worker_update", {
        worker: phase,
        phase,
        level,
        status,
        current_action: status === "running" ? `ejecutando ${phase}` : phase,
        token_count: tokensIn + tokensOut,
        transversal: phase === "security",
      })
    } catch {
      // worker activity is non-critical — never block on write failure
    }
  }

  private async persistWorkerActivity(doc: WorkerActivityDoc): Promise<void> {
    const workerActivity = await col<WorkerActivityDoc>("workerActivity")
    await workerActivity.put(doc.id, doc)
  }

  /** Returns the highest-capability model ID available for the configured provider */
  private async getHighestCapabilityModel(): Promise<string | null> {
    try {
      const rows = await (await col<ModelDoc>("models")).scan()
      const top = rows
        .map((entry) => entry.doc)
        .filter((model) => model.enabled && (model.capabilities ?? "").toLowerCase().includes("top"))
        .sort((a, b) => b.id.localeCompare(a.id))[0]
      return top?.id ?? null
    } catch {
      return null
    }
  }

  /** Run ForensicAgent as an on-demand temporary worker */
  /**
   * Public entry point for invoking ForensicAgent OUTSIDE the normal phase loop —
   * used when a task exhausts its process-level retries (FailureRecoveryScheduler)
   * without ever hitting a single worker's iteration limit. Requires startAll() to
   * have been called first (workspace/tools/secrets must be initialized).
   */
  async analyzeFailure(description: string, errorSummary: string, mode: "auto" | "approval" = "auto"): Promise<CoordinatorResult> {
    const taskId = this.activeTaskId || `forensic-${Date.now()}`
    if (!this.activeTaskId) this.activeTaskId = taskId
    const syntheticTask: CoordinatorTask = {
      taskId,
      phaseId: this.scribe.createPhase(taskId, "forensic", "forensic"),
      phase: "forensic",
      description: `Analyze why this task failed repeatedly across retries and never succeeded: ${description}. Last error: ${errorSummary.slice(0, 500)}`,
      narrative: "",
      mode,
      projectPath: process.cwd(),
    }
    return this.runForensicAgent("bee" as PhaseName, syntheticTask, {
      taskId,
      phaseId: syntheticTask.phaseId,
      coordinator: "bee",
      status: "failed",
      narrativeEntry: errorSummary,
      filesModified: [],
      durationMs: 0,
    })
  }

  private async runForensicAgent(
    failedPhase: PhaseName,
    originalTask: CoordinatorTask,
    failedResult: CoordinatorResult
  ): Promise<CoordinatorResult> {
    const taskId = this.activeTaskId || "forensic"
    const workspace = this.getTaskWorkspace(taskId)
    const phaseId = this.scribe.createPhase(taskId, "forensic", "forensic")
    const forensicTask: CoordinatorTask = {
      taskId,
      phaseId,
      phase: "forensic",
      description: originalTask.description || `Analyze why ${failedPhase} failed after exhausting iterations. Failed narrative: ${failedResult.narrativeEntry?.slice(0, 500)}`,
      narrative: originalTask.narrative || "",
      mode: originalTask.mode,
      projectPath: workspace.worktreePath,
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.worktreePath,
      branchName: workspace.branchName,
      isolated: workspace.isolated,
      secrets: this.secrets,
      provider: originalTask.provider,
      model: originalTask.model,
    }

    const forensicWorker = new (Worker as any)(new URL("./forensic.worker.ts", import.meta.url), { smol: true }) as Bun.Worker

    const tools = getToolsForCoordinator("forensic" as PhaseName, this.allTools)
    const compiledContext = await this.compileWorkerContext("forensic" as PhaseName, forensicTask.description, forensicTask.narrative)
    const msg: ManagerToWorkerMessage = {
      type: "TASK",
      task: { ...forensicTask, tools: tools as any, compiledContext },
    }

    return new Promise((resolve) => {
      const resolverKey = `${taskId}:${phaseId}`

      const timeout = setTimeout(() => {
        forensicWorker.terminate()
        resolve({
          taskId,
          phaseId,
          coordinator: "forensic",
          status: "failed",
          narrativeEntry: "ForensicAgent timed out.",
          filesModified: [],
          durationMs: 120_000,
        })
      }, 120_000)

      forensicWorker.onmessage = (msg: MessageEvent) => {
        const data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data
        if (data.type === "RESULT" && data.result) {
          clearTimeout(timeout)
          forensicWorker.terminate()
          resolve(data.result as CoordinatorResult)
        } else if (data.type === "TOOL_CALL") {
          // Handle tool calls from forensic worker
          this.handleToolCall("forensic" as PhaseName, data).catch(() => {})
        }
      }

      // Wire tool results back to forensic worker
      const origWorker = this.workers.get("forensic" as PhaseName)
      this.workers.set("forensic" as PhaseName, forensicWorker)
      forensicWorker.postMessage(JSON.stringify(msg))
      // Restore after done
      forensicWorker.addEventListener("close", () => {
        if (origWorker) this.workers.set("forensic" as PhaseName, origWorker)
        else this.workers.delete("forensic" as PhaseName)
      })
    })
  }

  /** Parse ForensicAgent recommendation from its narrative */
  private parseForensicRecommendation(narrative: string): { action: "retry_with_constraint" | "reasign" | "escalate"; detail: string } {
    const retryMatch = narrative.match(/relanzar_con_constraint:\s*(.+)/i)
    if (retryMatch) return { action: "retry_with_constraint", detail: retryMatch[1].trim() }

    const reasignMatch = narrative.match(/reasignar_a:\s*(.+)/i)
    if (reasignMatch) return { action: "reasign", detail: reasignMatch[1].trim() }

    const escalateMatch = narrative.match(/escalar_al_humano:\s*([\s\S]+)/i)
    if (escalateMatch) return { action: "escalate", detail: escalateMatch[1].trim() }

    return { action: "escalate", detail: "ForensicAgent did not produce a parseable recommendation." }
  }

  /**
   * Fallback string-match when the reviewer didn't call `submit_review_verdict`
   * (e.g. a weaker model that ignores tool calls). The primary path is the
   * structured decision handled above — deterministic checklist over free text.
   */
  private parseReviewerVerdict(narrative: string): "aprobado" | "aprobado_con_observaciones" | "rechazado" {
    const normalized = narrative.toLowerCase()
    if (normalized.includes("aprobado_con_observaciones") || normalized.includes("aprobado con observaciones")) {
      return "aprobado_con_observaciones"
    }
    if (normalized.includes("aprobado")) return "aprobado"
    return "rechazado"
  }

  /** Run Librarian as on-demand worker after reviewer approves */
  private async runLibrarianAgent(
    reviewerTask: CoordinatorTask,
    provider: string,
    model: string
  ): Promise<void> {
    if (!this.activeSessionId || !this.activeTaskId) return

    if (this.onIpcEvent) {
      this.onIpcEvent("librarian_progress", { status: "running", records_written: 0 })
    }

    const taskId = this.activeTaskId
    const workspace = this.getTaskWorkspace(taskId)
    const phaseId = this.scribe.createPhase(taskId, "librarian", "librarian")
    const libTask: CoordinatorTask = {
      taskId,
      phaseId,
      phase: "librarian",
      description: `Distill session knowledge into agent_memory for project: ${workspace.worktreePath}`,
      narrative: reviewerTask.narrative || "",
      mode: reviewerTask.mode,
      projectPath: workspace.worktreePath,
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.worktreePath,
      branchName: workspace.branchName,
      isolated: workspace.isolated,
      secrets: this.secrets,
      provider: provider || undefined,
      model: model || undefined,
    }

    const libWorker = new (Worker as any)(new URL("./librarian.worker.ts", import.meta.url), { smol: true }) as Bun.Worker

    const tools = getToolsForCoordinator("librarian" as PhaseName, this.allTools)
    const compiledContext = await this.compileWorkerContext("librarian" as PhaseName, libTask.description, libTask.narrative)
    const msg: ManagerToWorkerMessage = {
      type: "TASK",
      task: { ...libTask, tools: tools as any, compiledContext },
    }

    return new Promise((resolve) => {

      const timeout = setTimeout(() => {
        libWorker.terminate()
        log.warn("[coordinator-manager] Librarian timed out")
        resolve()
      }, 180_000)

      libWorker.onmessage = (msgEvent: MessageEvent) => {
        const data = typeof msgEvent.data === "string" ? JSON.parse(msgEvent.data) : msgEvent.data
        if (data.type === "RESULT") {
          clearTimeout(timeout)
          libWorker.terminate()
          if (this.onIpcEvent) {
            this.onIpcEvent("librarian_progress", { status: "done", records_written: 0 })
          }
          log.info("[coordinator-manager] Librarian completed memory distillation")
          resolve()
        } else if (data.type === "TOOL_CALL") {
          this.handleToolCall("librarian" as PhaseName, data).catch(() => {})
        }
      }

      this.workers.set("librarian" as PhaseName, libWorker)
      libWorker.postMessage(JSON.stringify(msg))
      libWorker.addEventListener("close", () => {
        this.workers.delete("librarian" as PhaseName)
        resolve()
      })
    })
  }

  private async dispatchPhase(phase: PhaseName, task: CoordinatorTask): Promise<CoordinatorResult> {
    const tools = getToolsForCoordinator(phase, this.allTools)
    const compiledContext = await this.compileWorkerContext(phase, task.description, task.narrative)

    return new Promise((resolve, reject) => {
      if (!this.workers.has(phase)) {
        this.createWorker(phase)
        log.info(`[coordinator-manager] Activated ${phase} on demand`)
      }
      const worker = this.workers.get(phase)
      if (!worker) {
        reject(new Error(`No worker for phase: ${phase}`))
        return
      }

      const idx = COORDINATOR_NAMES.indexOf(phase)
      setWorkerBusy(idx, true)
      const resolverKey = `${task.taskId}:${task.phaseId}`
      this.pendingResolvers.set(resolverKey, { resolve, reject })

      const timeout = setTimeout(() => {
        setWorkerBusy(idx, false)
        this.pendingResolvers.delete(resolverKey)
        this.pendingTimeouts.delete(resolverKey)
        reject(new TimeoutError(`Worker ${phase} timed out after 5 minutes`, { phase, durationMs: 300_000 }))
      }, 300_000)
      this.pendingTimeouts.set(resolverKey, timeout)

    // Send task with tools + compiled context via string fast-path (SPEC §3.1: ~500 ns latency)
    const msg: ManagerToWorkerMessage = {
      type: "TASK",
      task: { ...task, tools: tools as any, allTools: this.allTools, compiledContext },
    }
      worker.postMessage(JSON.stringify(msg))

  // Note: we don't set worker.onmessage here because it's already set in startAll
  // The handleWorkerMessage will call the correct resolver when it receives a RESULT
  })
  }

  /** Compile worker context: relevant skills, playbook rules, and scratchpad notes.
   *  Runs on main thread where DB is available; injects as string into CoordinatorTask. */
  private async compileWorkerContext(phase: PhaseName, taskDescription: string, narrative: string): Promise<string> {
    const sections: string[] = []

    // 0. Project context — injected for ALL coordinators (especially Bee)
    // This gives every worker a global map of the project without having to discover it
    try {
      const activeSession = (await (await col<CodeSessionDoc>("codeSessions")).findBy("status", "active"))
        .map((entry) => entry.doc)
        .sort((a, b) => b.last_active.localeCompare(a.last_active))[0]
      if (activeSession?.id) {
        const projectCtx = getProjectContext(activeSession.id)
        if (projectCtx) {
          sections.push(projectCtx)
        }
      }
    } catch {
      // skip if no active session or cache miss
    }

    // 1. Skills — minimal + HiveDB-discovered for this phase
    try {
      const minimalSkills = await getMinimalSkills()
      const discoveredSkills = await selectSkills(`${taskDescription} ${phase}`)
      const seen = new Set<string>()
      const allSkills: SkillDescriptor[] = []
      for (const s of [...minimalSkills, ...discoveredSkills]) {
        if (!seen.has(s.name)) { seen.add(s.name); allSkills.push(s) }
      }
      if (allSkills.length > 0) {
        let skillSection = "# SKILLS\nRelevant skills for this phase:\n\n"
        for (const skill of allSkills) {
          skillSection += `## ${skill.name}\n${skill.description}\n\n${skill.body}\n\n---\n\n`
        }
        sections.push(skillSection)
      }
    } catch (err) {
      log.warn(`[coordinator-manager] ⚠️ Skill compilation failed for ${phase}: ${(err as Error).message}`)
    }

    // 2. Playbook rules relevant to this coordinator
    try {
      const rules = (await (await col<CodePlaybookDoc>("codePlaybook")).findBy("active", true))
        .map((entry) => entry.doc)
        .filter((rule) => rule.coordinator === phase || rule.coordinator == null)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5)
      if (rules.length > 0) {
        let playbookSection = "# PLAYBOOK RULES\nFollow these verified patterns:\n\n"
        for (const r of rules) {
          playbookSection += `- [${(r.confidence * 100).toFixed(0)}%] ${r.rule}\n`
        }
        sections.push(playbookSection)
      }
    } catch {
      // Playbook may not have rows yet — skip silently
    }

    // 3. Agent memory from previous sessions (filtered by relevance + domain type)
    try {
      const projectId = process.cwd()
      const memoryTypeFilter: Partial<Record<PhaseName, string[]>> = {
        architecture:    ["pattern", "contract"],
        security:        ["antipattern"],
        test:            ["forensic_lesson"],
        verifier:        ["contract", "forensic_lesson"],
        reviewer:        ["pattern", "antipattern", "contract", "convention", "forensic_lesson"],
      }
      const typeFilter = memoryTypeFilter[phase]
      const query = `${taskDescription} ${phase}`.toLowerCase()
      const terms = query.split(/\W+/).filter(term => term.length > 2)
      const memories = (await (await col<AgentMemoryDoc>("agentMemory")).findBy("project_id", projectId))
        .map((entry) => entry.doc)
        .filter((memory) => !memory.deprecated)
        .filter((memory) => !typeFilter || typeFilter.includes(memory.type))
        .map((memory) => ({
          memory,
          score: terms.reduce((sum, term) => sum + (memory.content.toLowerCase().includes(term) ? 1 : 0), 0),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || (b.memory.confidence ?? 0) - (a.memory.confidence ?? 0))
        .slice(0, 8)
        .map((entry) => entry.memory)
      if (memories.length > 0) {
        let memSection = "# PROJECT MEMORY (from previous sessions)\nKnowledge accumulated by the swarm:\n\n"
        for (const m of memories) {
          memSection += `[${m.type}|${m.severity}] ${m.content}\n`
        }
        sections.push(memSection)
      }
    } catch {
      // Project memory is advisory — skip silently if unavailable.
    }

    // 4. Recent scratchpad / narrative context
    if (narrative) {
      sections.push(`# PROJECT NARRATIVE\n${narrative}`)
    }

    // 4.5 Decision traces — pushed proactively to parallel writers, not just
    // discoverable via read_narrative. Cognition Principle 1 ("share full agent
    // traces, not just individual messages"): a bare `decision` string lets two
    // parallel writers (backend/frontend/data_scientist) make conflicting
    // assumptions the blackboard can't reconcile after the fact; seeing what was
    // considered and discarded (`options`/`context`) before they write is what
    // catches the conflict before it becomes a bug.
    const traceReaders: PhaseName[] = ["backend", "frontend", "data_scientist", "reviewer", "verifier"]
    if (traceReaders.includes(phase)) {
      try {
        const activeDecisions = this.scribe.readDecisions("active").slice(0, 5)
        if (activeDecisions.length > 0) {
          let traceSection = "# DECISION TRACES (ADRs activos)\nQué se decidió, qué se consideró y por qué — no solo el resultado:\n\n"
          for (const adr of activeDecisions) {
            traceSection += `## ${adr.title}\nContexto: ${adr.context.slice(0, 300)}\nOpciones consideradas: ${adr.options.slice(0, 300)}\nDecisión: ${adr.decision.slice(0, 300)}\n\n`
          }
          sections.push(traceSection)
        }
      } catch {
        // Decision traces are advisory — skip silently if unavailable.
      }
    }

    // 5. Learning Harness — inject known failure patterns for Architecture coordinator
    if (phase === "architecture") {
      try {
        const patterns = this.scribe.getFailurePatterns({ minOccurrences: 3 })
        if (patterns.length > 0) {
          const patternBlock = patterns
            .map(p => `- ${p.agent}/${p.failureType}: ${p.count} ocurrencias (última: ${p.lastSeen})`)
            .join("\n")
          sections.push(`# PATRONES DE FALLO CONOCIDOS\nEvita repetir estos patrones al diseñar el plan:\n\n${patternBlock}`)
          for (const p of patterns) {
            try {
              this.scribe.writeProposal({
                sourceAgent: "architecture",
                proposalType: p.failureType === "tool_error" ? "skill_adjust" : "prompt_change",
                description: `Fallo repetido (${p.count}×): ${p.agent}/${p.failureType}. Revisar skill o prompt del agente.`,
                failureIds: p.ids,
              })
            } catch { /* dedup silencioso si ya existe */ }
          }
        }
      } catch { /* learning_failures puede no tener datos aún */ }
    }

    return sections.join("\n\n")
  }

  private handleWorkerMessage(name: PhaseName, rawMsg: WorkerToManagerMessage | string): void {
    const msg = typeof rawMsg === "string" ? JSON.parse(rawMsg) as WorkerToManagerMessage : rawMsg
    // A worker that talks back is healthy — reset its consecutive-crash counter
    // so a fresh crash later starts backoff from scratch rather than tripping
    // the circuit breaker on old, already-recovered crashes.
    if (this.workerCrashCounts.get(name)) this.workerCrashCounts.set(name, 0)
    if (msg.type === "RESULT" && msg.result) {
      // NOTE: We intentionally do NOT emit onNarrativeChunk here for the final
      // agent response, because the caller (executeTask via runTask) already
      // captures stdout and sends a HistoryAppend to the TUI. Emitting here
      // would duplicate the message. Tool calls still stream in real-time
      // via handleToolCall → onNarrativeChunk.

      // Format BEE's decision output for WebSocket subscribers
      let displayContent = msg.result.narrativeEntry
      if (name === "bee" && msg.result.narrativeEntry) {
        const decision = msg.result.structuredDecision
          ? normalizeBeeDecision(msg.result.structuredDecision)
          : parseBeeDecision(msg.result.narrativeEntry)
        displayContent = formatBeeNarrative(decision)
      }

      // Stream to WebSocket subscribers (persisted narrative is written by runTask/executePhaseLoop)
      if (this.activeTaskId) {
        broadcastNarrative(this.activeTaskId, {
          coordinator: msg.result.coordinator,
          phase: name,
          content: displayContent,
          timestamp: new Date().toISOString(),
        })
      }

      const resolverKey = `${msg.taskId}:${msg.phaseId}`
      clearTimeout(this.pendingTimeouts.get(resolverKey))
      this.pendingTimeouts.delete(resolverKey)
      const resolver = this.pendingResolvers.get(resolverKey)
      if (resolver) {
        resolver.resolve(msg.result)
        this.pendingResolvers.delete(resolverKey)
      }
      const idx = COORDINATOR_NAMES.indexOf(name)
      setWorkerBusy(idx, false)
      return
    }

    if (msg.type === "THINKING" && msg.content) {
      this.emitNarrativeChunk({
        coordinator: name,
        phase: "thinking",
        content: msg.content,
        streamId: (msg as any).streamId,
      })
      // Also broadcast thinking events to WebSocket subscribers (ThinkingPanel in UI)
      if (this.activeTaskId) {
        broadcastThinking(name, { content: msg.content, taskId: this.activeTaskId })
      }
      return
    }

    if (msg.type === "TOOL_CALL") {
      this.handleToolCall(name, msg).catch(err => {
        log.error(`[coordinator-manager] Tool call error: ${(err as Error).message}`)
      })
      return
    }
  }

  private async handleToolCall(name: PhaseName, msg: WorkerToManagerMessage): Promise<void> {
    const worker = this.workers.get(name)
    if (!worker || !msg.toolName || !msg.toolCallId) return
    const taskId = msg.taskId || this.activeTaskId || "unknown"

    // Check automatic interruptions (SPEC §6.3)
    const interruption = checkAutomaticInterruption(msg)
    if (interruption?.blocked) {
      log.warn(`[coordinator-manager] 🚫 Auto-interrupted: ${interruption.reason}`)
      this.writeToolTrace(name, msg.toolName, "", `[INTERRUPTION] ${interruption.reason}`, false, 0n)
      worker.postMessage(JSON.stringify({
        type: "TOOL_RESULT",
        toolCallId: msg.toolCallId,
        error: `[INTERRUPTION ${interruption.severity}] ${interruption.reason}`,
      } as ManagerToWorkerMessage))
      return
    }

    log.debug(`[coordinator-manager] 🛠️ ${name} calling tool: ${msg.toolName}`)

    // Meta-tool: BEE changes session mode at runtime
    if (msg.toolName === "set_session_mode") {
      const newMode = ((msg.toolArgs as any)?.mode ?? "auto") as SessionMode
      this.onModeChangeCb?.(newMode)
      this.onIpcEvent?.("mode_change", { mode: newMode })
      log.info(`[coordinator-manager] 🔄 Session mode changed to: ${newMode}`)
      worker.postMessage(JSON.stringify({
        type: "TOOL_RESULT",
        toolCallId: msg.toolCallId,
        result: JSON.stringify({ ok: true, mode: newMode }),
      } as ManagerToWorkerMessage))
      return
    }

    // Stream tool call to TUI so user sees what the agent is doing
    const humanDesc = formatToolCallForHuman(msg.toolName, msg.toolArgs || {})
    this.emitNarrativeChunk({
      coordinator: name,
      phase: msg.toolName || name,
      content: humanDesc,
      streamId: msg.toolCallId,
    })


    // Check plan mode gate
    const mode = getMode()
    const writeTools = new Set(["fs_write", "fs_edit", "fs_delete"])
    if (mode === "plan") {
      const planBlockedTools = new Set([
        "fs_write", "fs_edit", "fs_delete",
        "git_commit", "git_branch", "git_create_pr", "git_rollback",
      ])
      if (planBlockedTools.has(msg.toolName)) {
        const errorMsg = `Tool '${msg.toolName}' is disabled in PLAN mode. Only read operations are allowed.`
        log.warn(`[coordinator-manager] 🚫 Blocked ${msg.toolName} in plan mode`)
        this.writeToolTrace(name, msg.toolName, JSON.stringify(msg.toolArgs), errorMsg, false, 0n)
        worker.postMessage(JSON.stringify({
          type: "TOOL_RESULT",
          toolCallId: msg.toolCallId,
          error: errorMsg,
        } as ManagerToWorkerMessage))
        return
      }
    }

    let workspace = this.getTaskWorkspace(taskId)
    const writePath = writeTools.has(msg.toolName) && msg.toolArgs
      ? ((msg.toolArgs.path as string) || (msg.toolArgs.file as string) || "")
      : ""
    if (writePath) {
      try {
        workspace = await this.ensureTaskWorkspace(taskId, true)
      } catch (err) {
        const errorMsg = `[WORKTREE] Could not create isolated workspace: ${(err as Error).message}`
        log.warn(`[coordinator-manager] ⚠️ ${errorMsg}`)
        worker.postMessage(JSON.stringify({
          type: "TOOL_RESULT",
          toolCallId: msg.toolCallId,
          error: errorMsg,
        } as ManagerToWorkerMessage))
        return
      }
    }
    const workspaceRoot = workspace.worktreePath

    // Enforce confirmation for destructive operations
    if (msg.toolName === "fs_delete") {
      const confirmed = (msg.toolArgs as any)?.confirmed === true
      if (!confirmed) {
        const errorMsg = `Tool 'fs_delete' requires explicit user confirmation. Set confirmed: true only after user approval. File: ${(msg.toolArgs as any)?.path || "unknown"}`
        log.warn(`[coordinator-manager] 🚫 Blocked fs_delete without confirmation`)
        this.writeToolTrace(name, msg.toolName, "", errorMsg, false, 0n)
        worker.postMessage(JSON.stringify({
          type: "TOOL_RESULT",
          toolCallId: msg.toolCallId,
          error: errorMsg,
        } as ManagerToWorkerMessage))
        return
      }
    }

    // Dangerous action interceptor: validate shell commands from LLM agents (TDD §14)
    const shellTools = new Set(["code_build", "code_test", "code_lint", "run_script"])
    if (shellTools.has(msg.toolName) && msg.toolArgs) {
      const shellCmd = (msg.toolArgs.command || msg.toolArgs.path || "") as string
      if (shellCmd) {
        const cmdValidation = validateCommand(shellCmd, { workspace: workspaceRoot, mode })
        if (!cmdValidation.ok) {
          const v = cmdValidation as { ok: false; reason: string; fatal: boolean }
          const errorMsg = `[SAFETY] Command blocked: ${v.reason}`
          log.warn(`[coordinator-manager] 🛡️ Blocked ${msg.toolName}: ${v.reason}`)
          this.writeToolTrace(name, msg.toolName, JSON.stringify(msg.toolArgs).slice(0, 2000), errorMsg, false, 0n)
          worker.postMessage(JSON.stringify({
            type: "TOOL_RESULT",
            toolCallId: msg.toolCallId,
            error: v.fatal
              ? `${errorMsg} — This command is permanently blocked.`
              : `${errorMsg} — This action requires explicit user confirmation via the APPROVAL checkpoint.`,
          } as ManagerToWorkerMessage))
          return
        }
      }
    }

    let activeLease: WorkspaceLease | null = null

    if (writePath) {
      const operation: WorkspaceLeaseOperation =
        msg.toolName === "fs_delete" ? "delete" :
        msg.toolName === "fs_write" ? "write" : "edit"
      const leaseResult = this.workspaceLeases.acquire({
        taskId,
        workspaceId: workspace.workspaceId,
        path: writePath,
        heldByWorker: name,
        operation,
      })

      if (leaseResult.ok === false) {
        const conflict = leaseResult.conflict
        const errorMsg = `[LEASE] ${writePath} is currently reserved by ${conflict.heldByWorker} for task ${conflict.taskId}. Retry after that write completes.`
        log.warn(`[coordinator-manager] ⚠️ Lease blocked ${name} from writing ${writePath}`)
        this.writeToolTrace(name, msg.toolName, JSON.stringify(msg.toolArgs), errorMsg, false, 0n)
        this.onIpcEvent?.("conflict_alert", {
          agent_a: conflict.heldByWorker,
          agent_b: name,
          file: writePath,
          reason: "file lease conflict",
          severity: "high",
          detail: errorMsg,
        })
        worker.postMessage(JSON.stringify({
          type: "TOOL_RESULT",
          toolCallId: msg.toolCallId,
          error: errorMsg,
        } as ManagerToWorkerMessage))
        return
      }

      activeLease = leaseResult.lease

      const logicalWritePath = this.logicalPath(writePath, workspaceRoot)
      const canWrite = await this.checkWriteConflicts(name, logicalWritePath)
      if (!canWrite) {
        this.workspaceLeases.release(activeLease.leaseId)
        activeLease = null
        const errorMsg = `[CONFLICT] Another agent is writing to ${writePath}. Retry in a moment.`
        log.warn(`[coordinator-manager] ⚠️ Conflict blocked ${name} from writing ${writePath}`)
        this.writeToolTrace(name, msg.toolName, JSON.stringify(msg.toolArgs), errorMsg, false, 0n)
        worker.postMessage(JSON.stringify({
          type: "TOOL_RESULT",
          toolCallId: msg.toolCallId,
          error: errorMsg,
        } as ManagerToWorkerMessage))
        return
      }

      if (this.activeTaskId) {
        const absoluteWritePath = this.workspacePath(writePath, workspaceRoot)
        const exists = existsSync(absoluteWritePath)
        const existingPaths = exists ? [absoluteWritePath] : []
        const newPaths     = !exists && operation !== "delete" ? [absoluteWritePath] : []
        await this.checkpoint(`before ${msg.toolName} ${writePath}`, existingPaths, newPaths, name)
      }
    }

    // Execute the tool with timing (Heavy tools go to the worker pool)
    const inputSummary = JSON.stringify(msg.toolArgs || {}).slice(0, 2000)
    const toolStart = performance.now()
    
    const heavyTools = new Set(["code_search", "parse_ast", "check_types", "code_build", "code_test", "code_lint", "shell_executor"])
    let result: any

    try {
      if (heavyTools.has(msg.toolName!)) {
        result = await this.executeInToolWorker(msg.toolName!, msg.toolArgs || {}, { configurable: { workspace: workspaceRoot } })
      } else {
        result = await executeToolByName(
          this.allTools,
          msg.toolName!,
          msg.toolArgs || {},
          { configurable: { workspace: workspaceRoot } }
        )
      }
    } finally {
      if (activeLease) this.workspaceLeases.release(activeLease.leaseId)
    }
    
    const toolDurationNs = BigInt(Math.round((performance.now() - toolStart) * 1_000_000))
    const success = !(result && typeof result === "object" && "ok" in (result as any) && (result as any).ok === false)
    const outputSummary = typeof result === "string" ? result.slice(0, 2000) : JSON.stringify(result).slice(0, 2000)

    // Write tool execution trace (SPEC §5.4)
    this.writeToolTrace(name, msg.toolName, inputSummary, outputSummary, success, toolDurationNs)

    // Learning Harness — capture tool failure (fire-and-forget, WAL-safe)
    if (!success && this.activeTaskId) {
      try {
        this.scribe.writeFailure({
          taskId: this.activeTaskId,
          phaseId: null,
          agent: name,
          failureType: "tool_error",
          errorMessage: outputSummary,
          contextSummary: `tool=${msg.toolName} args=${JSON.stringify(msg.toolArgs ?? {}).slice(0, 200)}`,
        })
      } catch (failureWriteErr) {
        log.warn(`[coordinator-manager] Failed to write tool failure: ${(failureWriteErr as Error).message}`)
      }
    }

    // Evaluate file risk after a successful write so TUI can show risk badges
    if (success && writeTools.has(msg.toolName!) && msg.toolArgs) {
      const riskFilePath = (msg.toolArgs.path as string) || (msg.toolArgs.file as string) || ""
      if (riskFilePath) {
        const logicalRiskPath = this.logicalPath(riskFilePath, workspaceRoot)
        const riskOp = msg.toolName === "fs_delete"
          ? "deleted"
          : msg.toolName === "fs_write" ? "created" : "modified"
        this.evaluateFileRisk(logicalRiskPath, riskOp as "created" | "modified" | "deleted", name)

        // Sync code search index after successful write/edit (fire-and-forget)
        if (this.activeSessionId) {
          const absolutePath = this.workspacePath(riskFilePath, workspaceRoot)
          updateFileIndex(this.activeSessionId, absolutePath, workspaceRoot).catch((err) => {
            log.debug(`[coordinator-manager] code search sync failed for ${absolutePath}: ${(err as Error).message}`)
          })
        }

        // Emit file_diff so the CODE tab in TUI shows the actual changes
        if (msg.toolName !== "fs_delete" && this.onIpcEvent) {
          try {
            const diffResult = await executeToolByName(
              this.allTools, "git_diff",
              { path: workspaceRoot, file: logicalRiskPath },
              { configurable: { workspace: workspaceRoot } }
            ) as any
            const rawDiff: string = diffResult?.diff ?? diffResult?.content ?? ""
            if (rawDiff) {
              const chunks = parseUnifiedDiff(rawDiff)
              const added   = chunks.filter(c => c.kind === "add").length
              const removed = chunks.filter(c => c.kind === "remove").length
              this.onIpcEvent("file_diff", { path: logicalRiskPath, stats_added: added, stats_removed: removed, chunks, task_id: taskId })
            }
          } catch (diffErr) {
            log.debug(`[coordinator-manager] git_diff advisory failed: ${(diffErr as Error).message}`)
          }
        }
      }
    }

    // Stream tool result to TUI so user sees success/failure — use human-readable format
    const formattedForHuman = formatToolResult(msg.toolName, result)
    this.emitNarrativeChunk({
      coordinator: name,
      phase: msg.toolName,
      content: formattedForHuman,
      streamId: msg.toolCallId,
    })


    // Format tool result for LLM consumption (Kimi CLI style: <system> wrappers)
    // This gives the LLM clear context about what happened instead of raw JSON
    const formattedResult = formatToolResult(msg.toolName, result)

    // Send formatted result back to worker via string fast-path
    worker.postMessage(JSON.stringify({
      type: "TOOL_RESULT",
      toolCallId: msg.toolCallId,
      result: formattedResult,
    } as ManagerToWorkerMessage))

    log.debug(`[coordinator-manager] ✅ ${msg.toolName} result sent to ${name}`)
  }

  private writeToolTrace(
    coordinator: string,
    toolName: string,
    inputSummary: string,
    outputSummary: string,
    success: boolean,
    durationNs: bigint,
  ): void {
    try {
      this.scribe.writeTrace({
        taskId: this.activeTaskId || "unknown",
        agentId: coordinator,
        coordinator,
        toolName,
        inputSummary,
        outputSummary,
        success,
        durationNs: Number(durationNs),
      })
    } catch (err) {
      log.warn(`[coordinator-manager] ⚠️ Failed to write trace for ${toolName}: ${(err as Error).message}`)
    }
  }

  private handleControlMessage(msg: ControlMessage): void {
    log.info(`[coordinator-manager] Control message: ${msg.type} (mode: ${msg.payload.mode})`)

    switch (msg.type) {
      case "MODE_CHANGED":
        if (msg.payload.mode) {
          setMode(msg.payload.mode)
          log.info(`[coordinator-manager] 🔄 Mode changed to ${msg.payload.mode}`)
          if (this.activeSessionId) {
            broadcastMode(this.activeSessionId, msg.payload.mode)
          }
        }
        break
      case "TASK_CANCELLED":
        setCancelled(true)
        break
      case "PAUSE":
        break
      case "RESUME":
        break
      case "SHUTDOWN":
        this.stopAll()
        break
    }
  }

  getActiveTaskId(): string | null {
    return this.activeTaskId
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId
  }

  setNarrativeCallback(cb: NarrativeChunkCallback): void {
    this.onNarrativeChunk = cb
  }

  setTaskCompleteCallback(cb: ((response: string) => void) | undefined): void {
    this.onTaskComplete = cb
  }

  setWorkerUpdateCallback(cb: (update: { type: "tool_worker"; id: number; status: "idle" | "busy"; tool?: string }) => void): void {
    this.onWorkerUpdate = cb
  }

  /** Forward raw IPC events (file_risk_update, conflict_alert, etc.) to TUI socket. */
  setIpcCallback(cb: (event: string, payload: unknown) => void): void {
    this.onIpcEvent = cb
  }

  /** Called by BEE's set_session_mode tool to change mode at runtime. */
  setModeChangeCallback(cb: (mode: SessionMode) => void): void {
    this.onModeChangeCb = cb
  }

  /** Record a user override instruction into the narrative with is_override=1. */
  recordUserOverride(text: string): void {
    if (!this.activeTaskId || !this.activeSessionId) return
    this.scribe.appendNarrative({
      taskId: this.activeTaskId,
      sessionId: this.activeSessionId,
      coordinator: "user",
      phase: "override",
      entry: text,
      isDraft: false,
      isOverride: true,
    })
    log.info(`[coordinator-manager] 📝 User override recorded: ${text.slice(0, 80)}`)
  }
}
