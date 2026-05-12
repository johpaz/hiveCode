import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { logger } from "@johpaz/hive-code-core/utils/logger"
import { createAllTools } from "@johpaz/hive-code-core/tools"
import type { Config } from "@johpaz/hive-code-core/config"
import { loadConfig } from "@johpaz/hive-code-core/config"
import type { Tool } from "@johpaz/hive-code-core/tools"
import {
  getMode, setMode, getPhaseIndex, setPhaseIndex,
  setWorkerBusy, isWorkerBusy, setCancelled, isCancelled,
} from "../modes/session-array"
import { Scribe } from "../narrative/scribe"
import { loadSecrets, distributeSecrets } from "./secrets"
import { getToolsForCoordinator, executeToolByName } from "./tool-bridge"
import { parsePlan, getDefaultPhases, groupPhasesByLevel } from "./plan-parser"
import type { ParsedPhase } from "./plan-parser"
import { checkAutomaticInterruption } from "../modes/interruptions"
import { broadcastNarrative, broadcastPhase, broadcastMode } from "../modes/task-streaming"
import type {
  CoordinatorTask, CoordinatorResult, ControlMessage,
  PhaseName, SessionMode, CoordinatorStatus,
  WorkerToManagerMessage, ManagerToWorkerMessage,
} from "./types"

const log = logger.child("coordinator-manager")

const COORDINATOR_NAMES: PhaseName[] = [
  "architecture", "backend", "frontend", "security", "test", "devops",
]

const WORKER_EXT = import.meta.url.endsWith(".ts") ? ".worker.ts" : ".worker.js"

const COORDINATOR_FILES: Record<PhaseName, string> = {
  architecture: new URL(`./architecture${WORKER_EXT}`, import.meta.url).pathname,
  backend: new URL(`./backend${WORKER_EXT}`, import.meta.url).pathname,
  frontend: new URL(`./frontend${WORKER_EXT}`, import.meta.url).pathname,
  security: new URL(`./security${WORKER_EXT}`, import.meta.url).pathname,
  test: new URL(`./test${WORKER_EXT}`, import.meta.url).pathname,
  devops: new URL(`./devops${WORKER_EXT}`, import.meta.url).pathname,
}

export class CoordinatorManager {
  private workers: Map<PhaseName, Bun.Worker> = new Map()
  private scribe = new Scribe()
  private activeTaskId: string | null = null
  private activeSessionId: string | null = null
  private broadcastChannel: BroadcastChannel | null = null
  private pendingResolvers = new Map<string, (value: CoordinatorResult) => void>()
  private secrets: Record<string, string> = {}
  private allTools: Tool[] = []

  async startAll(): Promise<void> {
    const db = getDb()
    log.info("[coordinator-manager] Starting 6 coordinators...")

    // Load and distribute secrets BEFORE creating workers
    this.secrets = loadSecrets()
    distributeSecrets(this.secrets)

    // Load all tools from core
    try {
      const config = await loadConfig()
      this.allTools = createAllTools(config)
      log.info(`[coordinator-manager] 📦 Loaded ${this.allTools.length} tools`)
    } catch (err) {
      log.warn(`[coordinator-manager] ⚠️  Failed to load tools: ${(err as Error).message}`)
      this.allTools = []
    }

    for (const name of COORDINATOR_NAMES) {
      this.createWorker(name)
    }

    this.broadcastChannel = new BroadcastChannel("hive-code:control")
    this.broadcastChannel.onmessage = (event: any) => this.handleControlMessage(event.data as ControlMessage)

    log.info("[coordinator-manager] ✅ All coordinators running")
  }

  private createWorker(name: PhaseName): void {
    try {
      const worker = new (Worker as any)(COORDINATOR_FILES[name], { smol: name === "security" || name === "devops" }) as Bun.Worker
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
        } catch { /* ignore trace write failures during crash */ }
        this.workers.delete(name)
        // Auto-restart with exponential backoff
        setTimeout(() => {
          this.createWorker(name)
          log.info(`[coordinator-manager] 🔄 ${name} worker restarted`)
        }, 1000)
      }
      this.workers.set(name, worker)
      log.info(`[coordinator-manager] ✅ ${name} started`)
    } catch (err) {
      log.error(`[coordinator-manager] ❌ Failed to start ${name}: ${(err as Error).message}`)
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, worker] of this.workers) {
      worker.terminate()
      log.info(`[coordinator-manager] ${name} terminated`)
    }
    this.workers.clear()
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
    this.activeSessionId = this.scribe.createSession(process.cwd())
    this.activeTaskId = this.scribe.createTask(this.activeSessionId, description, mode)

    log.info(`[coordinator-manager] 🚀 Task ${this.activeTaskId} (mode: ${mode}): ${description}`)

    // Create git branch for this task
    const branchName = `hive-code/task-${this.activeTaskId}`
    try {
      const gitResult = await executeToolByName(this.allTools, "git_branch", {
        action: "create",
        name: branchName,
        path: process.cwd(),
      })
      if ((gitResult as any)?.ok) {
        this.scribe.updateTaskStatus(this.activeTaskId, "planning", { branchName })
        log.info(`[coordinator-manager] 🌿 Branch created: ${branchName}`)
      } else {
        log.warn(`[coordinator-manager] ⚠️  Could not create branch: ${(gitResult as any)?.error || "unknown"}`)
      }
    } catch (err) {
      log.warn(`[coordinator-manager] ⚠️  Git branch creation failed: ${(err as Error).message}`)
    }

    // Phase 1: Architecture
    const archPhaseId = this.scribe.createPhase(this.activeTaskId, "architecture", "architecture")
    const archTask: CoordinatorTask = {
      taskId: this.activeTaskId,
      phaseId: archPhaseId,
      phase: "architecture",
      description,
      narrative: "",
      mode: mode ?? getMode(),
      projectPath: process.cwd(),
      secrets: this.secrets,
    }
    const archResult = await this.dispatchPhase("architecture", archTask)

    if (archResult.status === "failed" || archResult.status === "blocked") {
      this.scribe.updateTaskStatus(this.activeTaskId, "failed")
      log.error(`[coordinator-manager] ❌ Architecture phase failed: ${archResult.blockerDescription}`)
      return
    }

    // Parse the architecture output into a structured plan
    const plan = parsePlan(archResult.narrativeEntry)

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
      this.scribe.updateTaskStatus(this.activeTaskId, "completed")
      log.info(`[coordinator-manager] 📋 Plan mode — task completed at architecture phase`)
      log.info(`[coordinator-manager] 📋 Planned phases: ${plan.phases.map(p => p.coordinator).join(" → ")}`)
      return
    }

    // Execute dynamic phases from the architecture plan
    const phases = plan.phases.length > 0 ? plan.phases : getDefaultPhases()
    const levels = groupPhasesByLevel(phases)

    log.info(`[coordinator-manager] 📋 Executing ${phases.length} phases in ${levels.length} level(s):`)
    for (let lvl = 0; lvl < levels.length; lvl++) {
      const levelPhases = levels[lvl]
      log.info(`[coordinator-manager]    Level ${lvl}: ${levelPhases.map(p => p.coordinator).join(" + ")}`)
    }

    let globalPhaseIndex = 0

    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      if (isCancelled()) break

      const phaseMode = getMode()
      const levelPhases = levels[levelIdx]

      if (phaseMode === "plan") {
        log.info(`[coordinator-manager] 📋 Switched to plan — skipping level ${levelIdx}`)
        globalPhaseIndex += levelPhases.length
        continue
      }

      // Create tasks for all phases in this level
      const levelTasks: Array<{ phase: PhaseName; task: CoordinatorTask }> = levelPhases.map(phaseDef => {
        const phase = phaseDef.coordinator
        const task: CoordinatorTask = {
          taskId: this.activeTaskId || "current",
          phaseId: this.scribe.createPhase(this.activeTaskId || "current", phase, phase),
          phase,
          description,
          adr: archResult.narrativeEntry,
          interfaces: plan.interfaces,
          narrative: archResult.narrativeEntry,
          mode: phaseMode,
          projectPath: process.cwd(),
          secrets: this.secrets,
        }
        return { phase, task }
      })

      // Dispatch all phases in this level in parallel
      const results = await Promise.all(
        levelTasks.map(({ phase, task }) => this.dispatchPhase(phase, task))
      )

      // Check results
      for (let r = 0; r < results.length; r++) {
        const result = results[r]
        const { phase, task } = levelTasks[r]

        if (result.status === "failed") {
          this.scribe.updateTaskStatus(this.activeTaskId, "failed")
          log.error(`[coordinator-manager] ❌ ${phase} phase failed: ${result.blockerDescription}`)
          return
        }

        if (result.status === "blocked") {
          this.scribe.updatePhaseStatus(task.phaseId, "blocked", result.blockerDescription)
          this.scribe.updateTaskStatus(this.activeTaskId, "paused")
          log.warn(`[coordinator-manager] ⚠️ ${phase} phase blocked: ${result.blockerDescription}`)
          return
        }

        this.scribe.updatePhaseStatus(task.phaseId, "completed", result.narrativeEntry)

        // Stream phase completion to WebSocket subscribers
        if (this.activeTaskId) {
          broadcastPhase(this.activeTaskId, {
            name: phase,
            status: "completed",
            coordinator: phase,
            durationMs: result.durationMs,
          })
        }
      }

      // Approval mode checkpoint — after each level completes
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
          this.scribe.updateTaskStatus(this.activeTaskId, "cancelled")
          log.info(`[coordinator-manager] ❌ Task cancelled by user at level ${levelIdx}`)
          return
        }

        if (decision === "skip") {
          for (const { task } of levelTasks) {
            this.scribe.updatePhaseStatus(task.phaseId, "skipped")
          }
          log.info(`[coordinator-manager] ⏭️  Skipped level ${levelIdx}`)
          globalPhaseIndex += levelPhases.length
          continue
        }

        // decision === "approve"
        log.info(`[coordinator-manager] ✅ Level ${levelIdx} approved`)
      }

      globalPhaseIndex += levelPhases.length
    }

    this.scribe.updateTaskStatus(this.activeTaskId, "completed")
    log.info(`[coordinator-manager] ✅ Task ${this.activeTaskId} completed`)
  }

  private dispatchPhase(phase: PhaseName, task: CoordinatorTask): Promise<CoordinatorResult> {
    return new Promise((resolve, reject) => {
      const worker = this.workers.get(phase)
      if (!worker) {
        reject(new Error(`No worker for phase: ${phase}`))
        return
      }

      const idx = COORDINATOR_NAMES.indexOf(phase)
      setWorkerBusy(idx, true)
      const resolverKey = `${task.taskId}:${task.phaseId}`
      this.pendingResolvers.set(resolverKey, resolve)

      const timeout = setTimeout(() => {
        setWorkerBusy(idx, false)
        this.pendingResolvers.delete(resolverKey)
        reject(new Error(`Worker ${phase} timed out after 5 minutes`))
      }, 300_000)

      // Get tools for this coordinator
      const tools = getToolsForCoordinator(phase, this.allTools)

      // Send task with tools via string fast-path (SPEC §3.1: ~500 ns latency)
      const msg: ManagerToWorkerMessage = {
        type: "TASK",
        task: { ...task, tools: tools as any },
      }
      worker.postMessage(JSON.stringify(msg))

      // Note: we don't set worker.onmessage here because it's already set in startAll
      // The handleWorkerMessage will call the correct resolver when it receives a RESULT
    })
  }

  private handleWorkerMessage(name: PhaseName, rawMsg: WorkerToManagerMessage | string): void {
    const msg = typeof rawMsg === "string" ? JSON.parse(rawMsg) as WorkerToManagerMessage : rawMsg
    if (msg.type === "RESULT" && msg.result) {
      // Write narrative entry for this phase
      if (this.activeTaskId && this.activeSessionId) {
        this.scribe.appendNarrative({
          taskId: this.activeTaskId,
          sessionId: this.activeSessionId,
          coordinator: msg.result.coordinator,
          phase: name,
          entry: msg.result.narrativeEntry,
          isDraft: false,
          isOverride: false,
        })
        log.debug(`[coordinator-manager] 📝 Narrative entry saved for ${name}`)

        // Stream to WebSocket subscribers
        broadcastNarrative(this.activeTaskId, {
          coordinator: msg.result.coordinator,
          phase: name,
          content: msg.result.narrativeEntry,
          timestamp: new Date().toISOString(),
        })
      }

      const resolverKey = `${msg.taskId}:${msg.phaseId}`
      const resolver = this.pendingResolvers.get(resolverKey)
      if (resolver) {
        resolver(msg.result)
        this.pendingResolvers.delete(resolverKey)
      }
      const idx = COORDINATOR_NAMES.indexOf(name)
      setWorkerBusy(idx, false)
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

    // Check automatic interruptions (SPEC §6.3)
    const interruption = checkAutomaticInterruption(msg)
    if (interruption?.blocked) {
      log.warn(`[coordinator-manager] 🚫 Auto-interrupted: ${interruption.reason}`)
      worker.postMessage(JSON.stringify({
        type: "TOOL_RESULT",
        toolCallId: msg.toolCallId,
        error: `[INTERRUPTION ${interruption.severity}] ${interruption.reason}`,
      } as ManagerToWorkerMessage))
      return
    }

    log.debug(`[coordinator-manager] 🛠️  ${name} calling tool: ${msg.toolName}`)

    // Check plan mode gate
    const mode = getMode()
    if (mode === "plan") {
      const writeTools = new Set([
        "fs_write", "fs_edit", "fs_delete",
        "git_commit", "git_branch", "git_create_pr", "git_rollback",
        "append_narrative", "write_decision",
      ])
      if (writeTools.has(msg.toolName)) {
        const errorMsg = `Tool '${msg.toolName}' is disabled in PLAN mode. Only read operations are allowed.`
        log.warn(`[coordinator-manager] 🚫 Blocked ${msg.toolName} in plan mode`)
        worker.postMessage({
          type: "TOOL_RESULT",
          toolCallId: msg.toolCallId,
          error: errorMsg,
        } as ManagerToWorkerMessage)
        return
      }
    }

    // Create snapshot before write operations
    const writeTools = new Set(["fs_write", "fs_edit", "fs_delete"])
    if (writeTools.has(msg.toolName) && this.activeTaskId && msg.toolArgs) {
      await this.createSnapshot(msg.toolArgs.path as string || msg.toolArgs.file as string)
    }

    // Enforce confirmation for destructive operations
    if (msg.toolName === "fs_delete") {
      const confirmed = (msg.toolArgs as any)?.confirmed === true
      if (!confirmed) {
        const errorMsg = `Tool 'fs_delete' requires explicit user confirmation. Set confirmed: true only after user approval. File: ${(msg.toolArgs as any)?.path || "unknown"}`
        log.warn(`[coordinator-manager] 🚫 Blocked fs_delete without confirmation`)
        worker.postMessage(JSON.stringify({
          type: "TOOL_RESULT",
          toolCallId: msg.toolCallId,
          error: errorMsg,
        } as ManagerToWorkerMessage))
        return
      }
    }

    // Execute the tool
    const result = await executeToolByName(
      this.allTools,
      msg.toolName,
      msg.toolArgs || {}
    )

    // Send result back to worker via string fast-path
    worker.postMessage(JSON.stringify({
      type: "TOOL_RESULT",
      toolCallId: msg.toolCallId,
      result,
    } as ManagerToWorkerMessage))

    log.debug(`[coordinator-manager] ✅ ${msg.toolName} result sent to ${name}`)
  }

  private async createSnapshot(filePath: string | undefined): Promise<void> {
    if (!filePath || !this.activeTaskId) return
    try {
      const file = Bun.file(filePath)
      if (await file.exists()) {
        const content = await file.text()
        const hasher = new Bun.CryptoHasher("sha256")
        hasher.update(content)
        const hash = hasher.digest("hex")
        this.scribe.saveSnapshot(this.activeTaskId, filePath, content, hash)
        log.debug(`[coordinator-manager] 💾 Snapshot created: ${filePath}`)
      }
    } catch (err) {
      log.warn(`[coordinator-manager] ⚠️  Failed to create snapshot for ${filePath}: ${(err as Error).message}`)
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
}
