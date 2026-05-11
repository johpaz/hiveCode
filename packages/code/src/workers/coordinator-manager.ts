import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { logger } from "@johpaz/hive-code-core/utils/logger"
import { createAllTools } from "@johpaz/hive-code-core/tools"
import type { Config } from "@johpaz/hive-code-core/config"
import { loadConfig } from "@johpaz/hive-code-core/config"
import type { Tool } from "@johpaz/hive-code-core/tools/types"
import {
  getMode, setMode, getPhaseIndex, setPhaseIndex,
  setWorkerBusy, isWorkerBusy, setCancelled, isCancelled,
} from "../modes/session-array"
import { Scribe } from "../narrative/scribe"
import { loadSecrets, distributeSecrets } from "./secrets"
import { getToolsForCoordinator, executeToolByName } from "./tool-bridge"
import { parsePlan, getDefaultPhases } from "./plan-parser"
import type { ParsedPhase } from "./plan-parser"
import type {
  CoordinatorTask, CoordinatorResult, ControlMessage,
  PhaseName, SessionMode, CoordinatorStatus,
  WorkerToManagerMessage, ManagerToWorkerMessage,
} from "./types"

const log = logger.child("coordinator-manager")

const COORDINATOR_NAMES: PhaseName[] = [
  "architecture", "backend", "frontend", "security", "test", "devops",
]

const COORDINATOR_FILES: Record<PhaseName, string> = {
  architecture: new URL("./architecture.worker.ts", import.meta.url).pathname,
  backend: new URL("./backend.worker.ts", import.meta.url).pathname,
  frontend: new URL("./frontend.worker.ts", import.meta.url).pathname,
  security: new URL("./security.worker.ts", import.meta.url).pathname,
  test: new URL("./test.worker.ts", import.meta.url).pathname,
  devops: new URL("./devops.worker.ts", import.meta.url).pathname,
}

export class CoordinatorManager {
  private workers: Map<PhaseName, Bun.Worker> = new Map()
  private scribe = new Scribe()
  private activeTaskId: string | null = null
  private activeSessionId: string | null = null
  private broadcastChannel: BroadcastChannel | null = null
  private pendingResolve: ((value: CoordinatorResult) => void) | null = null
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
      try {
        const worker = new (Worker as any)(COORDINATOR_FILES[name], { smol: name === "security" || name === "devops" }) as Bun.Worker
        worker.onmessage = (msg: MessageEvent) => this.handleWorkerMessage(name, msg.data as WorkerToManagerMessage)
        worker.onerror = (err: ErrorEvent) => log.error(`[${name}] Worker error: ${err.message}`)
        this.workers.set(name, worker)
        log.info(`[coordinator-manager] ✅ ${name} started`)
      } catch (err) {
        log.error(`[coordinator-manager] ❌ Failed to start ${name}: ${(err as Error).message}`)
      }
    }

    this.broadcastChannel = new BroadcastChannel("hive-code:control")
    this.broadcastChannel.onmessage = (event: MessageEvent<ControlMessage>) => this.handleControlMessage(event.data)

    log.info("[coordinator-manager] ✅ All coordinators running")
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

    // Phase 1: Architecture
    const archResult = await this.dispatchPhase("architecture", { description })

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
        id: crypto.randomUUID(),
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
    log.info(`[coordinator-manager] 📋 Executing phases: ${phases.map(p => p.coordinator).join(" → ")}`)

    for (let i = 0; i < phases.length; i++) {
      if (isCancelled()) break
      const phaseMode = getMode()
      const phaseDef = phases[i]
      const phase = phaseDef.coordinator

      if (phaseMode === "plan") {
        log.info(`[coordinator-manager] 📋 Switched to plan — skipping execution phase ${phase}`)
        continue
      }

      const task: CoordinatorTask = {
        taskId: this.activeTaskId,
        phaseId: this.scribe.createPhase(this.activeTaskId, phase, phase),
        phase,
        description,
        adr: archResult.narrativeEntry,
        interfaces: plan.interfaces,
        narrative: archResult.narrativeEntry,
        mode: phaseMode,
        projectPath: process.cwd(),
        secrets: this.secrets,
      }

      const result = await this.dispatchPhase(phase, task)

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

      // Approval mode checkpoint
      if (phaseMode === "approval" && onApprovalCheckpoint) {
        this.scribe.updatePhaseStatus(task.phaseId, "running")
        log.info(`[coordinator-manager] 🟡 ${phase} awaiting approval`)

        const decision = await onApprovalCheckpoint({
          phase,
          phaseIndex: i,
          totalPhases: phases.length,
          narrativeEntry: result.narrativeEntry,
          nextPhase: phases[i + 1]?.coordinator,
        })

        if (decision === "cancel") {
          this.scribe.updateTaskStatus(this.activeTaskId, "cancelled")
          log.info(`[coordinator-manager] ❌ Task cancelled by user at ${phase} phase`)
          return
        }

        if (decision === "skip") {
          this.scribe.updatePhaseStatus(task.phaseId, "skipped")
          log.info(`[coordinator-manager] ⏭️  Skipped ${phase} phase`)
          continue
        }

        // decision === "approve"
        log.info(`[coordinator-manager] ✅ ${phase} approved`)
      }

      this.scribe.updatePhaseStatus(task.phaseId, "completed", result.narrativeEntry)
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
      this.pendingResolve = resolve

      const timeout = setTimeout(() => {
        setWorkerBusy(idx, false)
        this.pendingResolve = null
        reject(new Error(`Worker ${phase} timed out after 5 minutes`))
      }, 300_000)

      // Get tools for this coordinator
      const tools = getToolsForCoordinator(phase, this.allTools)

      // Send task with tools via new protocol
      const msg: ManagerToWorkerMessage = {
        type: "TASK",
        task: { ...task, tools: tools as any },
      }
      worker.postMessage(msg)

      // Note: we don't set worker.onmessage here because it's already set in startAll
      // The handleWorkerMessage will call pendingResolve when it receives a RESULT
    })
  }

  private handleWorkerMessage(name: PhaseName, msg: WorkerToManagerMessage): void {
    if (msg.type === "RESULT" && msg.result) {
      if (this.pendingResolve) {
        this.pendingResolve(msg.result)
        this.pendingResolve = null
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

    // Execute the tool
    const result = await executeToolByName(
      this.allTools,
      msg.toolName,
      msg.toolArgs || {}
    )

    // Send result back to worker
    worker.postMessage({
      type: "TOOL_RESULT",
      toolCallId: msg.toolCallId,
      result,
    } as ManagerToWorkerMessage)

    log.debug(`[coordinator-manager] ✅ ${msg.toolName} result sent to ${name}`)
  }

  private async createSnapshot(filePath: string | undefined): Promise<void> {
    if (!filePath || !this.activeTaskId) return
    try {
      const file = Bun.file(filePath)
      if (await file.exists()) {
        const content = await file.text()
        const hash = await Bun.CryptoHasher.hash("sha256", content).toString("hex")
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
