import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { getSessionDb, closeSessionDb } from "@johpaz/hivecode-core/db/client"
import { getMemoryDb } from "@johpaz/hivecode-core/storage/memory-db"
import { MemoryRepo } from "@johpaz/hivecode-core/storage/memory-repo"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import { createAllTools } from "@johpaz/hivecode-core/tools"
import type { Config } from "@johpaz/hivecode-core/config"
import { loadConfig } from "@johpaz/hivecode-core/config"
import type { Tool } from "@johpaz/hivecode-core/tools"
import { selectSkills, getMinimalSkills, type SkillDescriptor } from "@johpaz/hivecode-core/agent/skill-selector"
import { syncSkillsToFTS } from "@johpaz/hivecode-core/agent/context-compiler"
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
import { checkAutomaticInterruption } from "../modes/interruptions"
import { broadcastNarrative, broadcastPhase, broadcastMode, broadcastPhaseStart, broadcastPhaseEnd, broadcastTaskEnd, broadcastThinking } from "@johpaz/hivecode-core/gateway/task-streaming"
import { validateCommand } from "@johpaz/hivecode-core/tools/code/command-validator"
import { incrementTaskCounter, shouldRunReflector, runReflector, startReflectorCron, stopReflectorCron } from "../agent/reflector"
import type {
  CoordinatorTask, CoordinatorResult, BeeDecision, ControlMessage,
  PhaseName, SessionMode, CoordinatorStatus,
  WorkerToManagerMessage, ManagerToWorkerMessage,
} from "./types"
import { CoordinatorBase } from "../coordinator/base.ts"
import { makeGatewayEmitter } from "../context/ipc-emitter.ts"
import {
  parseBeeDecision, formatBeeNarrative, formatToolCallForHuman,
  formatToolResult, parseGitDiffStat, repairJson,
  smartTruncate, smartTruncateLines,
} from "../coordinator/utils.ts"

const log = logger.child("coordinator-manager")

// BEE is index 0 in the bitmask; coordinators follow at indices 1-9
// librarian and forensic are on-demand workers — not in the persistent pool
const COORDINATOR_NAMES: PhaseName[] = [
  "bee", "architecture", "backend", "frontend", "security", "test", "devops",
  "dba", "integration", "reviewer",
]

const WORKER_EXT = import.meta.url.endsWith(".ts") ? ".worker.ts" : ".worker.js"

const COORDINATOR_FILES: Record<PhaseName, string> = {
  bee: new URL(`./bee${WORKER_EXT}`, import.meta.url).pathname,
  architecture: new URL(`./architecture${WORKER_EXT}`, import.meta.url).pathname,
  backend: new URL(`./backend${WORKER_EXT}`, import.meta.url).pathname,
  frontend: new URL(`./frontend${WORKER_EXT}`, import.meta.url).pathname,
  security: new URL(`./security${WORKER_EXT}`, import.meta.url).pathname,
  test: new URL(`./test${WORKER_EXT}`, import.meta.url).pathname,
  devops: new URL(`./devops${WORKER_EXT}`, import.meta.url).pathname,
  dba: new URL(`./dba${WORKER_EXT}`, import.meta.url).pathname,
  integration: new URL(`./integration${WORKER_EXT}`, import.meta.url).pathname,
  reviewer: new URL(`./reviewer${WORKER_EXT}`, import.meta.url).pathname,
  librarian: new URL(`./librarian${WORKER_EXT}`, import.meta.url).pathname,
  forensic: new URL(`./forensic${WORKER_EXT}`, import.meta.url).pathname,
}

export class CoordinatorManager extends CoordinatorBase {
  private workers: Map<PhaseName, Bun.Worker> = new Map()
  private scribe = new Scribe()
  private activeTaskId: string | null = null
  private activeSessionId: string | null = null
  private broadcastChannel: BroadcastChannel | null = null
  private pendingResolvers = new Map<string, (value: CoordinatorResult) => void>()
  private pendingTimeouts  = new Map<string, ReturnType<typeof setTimeout>>()
  private secrets: Record<string, string> = {}
  private allTools: Tool[] = []
  private toolWorkerPool: Bun.Worker[] = []
  private currentLevel = 0
  private idleToolWorkers: Bun.Worker[] = []
  private toolResolvers = new Map<string, (res: any) => void>()
  private onNarrativeChunk?: (chunk: { coordinator: string; phase: string; content: string; streamId?: string }) => void
  private onWorkerUpdate?: (update: { type: "tool_worker"; id: number; status: "idle" | "busy"; tool?: string }) => void
  private onTaskComplete?: (response: string) => void
  private onIpcEvent?: (event: string, payload: unknown) => void

  /** Reload secrets from Bun.secrets and providers table */
  reloadSecrets(): void {
    const db = getDb()
    this.secrets = loadSecrets()

    // Primary fallback: read API keys from providers table (stored by /provider wizard)
    const providerRows = db.query(
      "SELECT id, api_key_encrypted FROM providers WHERE enabled = 1 AND api_key_encrypted IS NOT NULL"
    ).all() as { id: string; api_key_encrypted: string }[]
    for (const row of providerRows) {
      const envKey = `${row.id.toUpperCase().replace(/-/g, "_")}_API_KEY`
      if (!this.secrets[envKey]) {
        this.secrets[envKey] = Buffer.from(row.api_key_encrypted, "base64").toString()
      }
    }

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
    log.info("[coordinator-manager] Starting BEE + 6 coordinators...")

    // Load and distribute secrets BEFORE creating workers
    this.reloadSecrets()

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

    this.broadcastChannel = new BroadcastChannel("hivecode:control")
    this.broadcastChannel.onmessage = (event: any) => this.handleControlMessage(event.data as ControlMessage)

    this.initToolPool(4)

    startReflectorCron()
    log.info("[coordinator-manager] ✅ BEE + all coordinators running (Tool Pool: 4 workers)")
  }

  private initToolPool(size: number): void {
    const workerPath = new URL("./tool.worker.ts", import.meta.url).pathname
    for (let i = 0; i < size; i++) {
      const worker = new (Worker as any)(workerPath, { smol: true }) as Bun.Worker
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
    // Open per-session DB and wire all subsystems (Blackboard, Checkpoint, ADR, Risk)
    const sessionDb = getSessionDb(this.activeSessionId)
    // Use a combined emitter: gateway broadcast + optional TUI socket callback
    const gatewayIpc = makeGatewayEmitter(this.activeSessionId)
    const onIpcEvent = this.onIpcEvent
    const ipc = onIpcEvent
      ? { emit(event: string, payload: unknown) { gatewayIpc.emit(event, payload); onIpcEvent(event, payload) } }
      : gatewayIpc
    this.initSubsystems(sessionDb, this.activeSessionId, ipc)
    this.loadProjectAdrs(process.cwd())
    return this.activeSessionId
  }

  /** Close the session when TUI exits */
  closeSession(): void {
    if (this.activeSessionId) {
      this.scribe.closeSession(this.activeSessionId)
      closeSessionDb(this.activeSessionId)
      this.activeSessionId = null
    }
  }

  getSessionId(): string | null {
    return this.activeSessionId
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
    stopReflectorCron()
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

    // Ensure we have a session (created at TUI startup via openSession(), fallback here)
    if (!this.activeSessionId) {
      this.activeSessionId = this.scribe.createSession(process.cwd())
      const sessionDb = getSessionDb(this.activeSessionId)
      const ipc = makeGatewayEmitter(this.activeSessionId)
      this.initSubsystems(sessionDb, this.activeSessionId, ipc)
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
    const taskStartTime = performance.now()

    // Resolve provider/model from code_config (set by REPL or provider add command)
    const db = getDb()
    const configuredProvider = (
      db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get() as any
    )?.value ?? ""
    const configuredModel = configuredProvider
      ? (db.query("SELECT value FROM code_config WHERE key = ?").get(`provider_model_${configuredProvider}`) as any)?.value ?? ""
      : ""

    log.info(`[coordinator-manager] 🚀 Task ${this.activeTaskId} (mode: ${mode}, provider: ${configuredProvider || "env-default"}): ${description}`)

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
      projectPath: process.cwd(),
      conversationHistory,
      secrets: this.secrets,
      provider: configuredProvider || undefined,
      model: configuredModel || undefined,
    }
    const beeResult = await this.dispatchPhase("bee", beeTask)

    // Parse BEE's decision early so we store a human-readable narrative
    const beeDecision = parseBeeDecision(beeResult.narrativeEntry)
    const beeNarrative = beeResult.status === "failed" || beeResult.status === "blocked"
      ? (beeResult.blockerDescription || beeResult.narrativeEntry || "")
      : formatBeeNarrative(beeResult.narrativeEntry)

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
    }

    // ── Route based on BEE's decision ─────────────────────────────────────────

    // RESPOND: BEE handled it directly — return the answer to the user
    if (beeDecision.action === "respond") {
      const response = beeDecision.content ?? ""
      this.scribe.updateTaskStatus(this.activeTaskId, "completed")
      this.scribe.updateTaskMetadata(this.activeTaskId, {
        tokensIn: beeResult.tokensIn ?? 0, tokensOut: beeResult.tokensOut ?? 0,
        filesChanged: 0, linesAdded: 0, linesRemoved: 0,
        durationMs: Math.round(performance.now() - taskStartTime),
      })
      this.scribe.completeTurn(turnId, response, null)
      if (this.onTaskComplete) this.onTaskComplete(response)
      if (response) process.stdout.write(response + "\n")
      return
    }

    // FIX: BEE applied a direct fix — report the summary and finish
    if (beeDecision.action === "fix") {
      const response = beeDecision.content ?? ""
      const fileChanges: FileChange[] = (beeDecision.filesModified ?? []).map(f => ({
        filePath: f, changeType: "modified" as const, linesAdded: 0, linesRemoved: 0,
      }))
      if (fileChanges.length) this.scribe.writeFileChanges(this.activeTaskId, beePhaseId, fileChanges)
      this.scribe.updateTaskStatus(this.activeTaskId, "completed")
      this.scribe.updateTaskMetadata(this.activeTaskId, {
        tokensIn: beeResult.tokensIn ?? 0, tokensOut: beeResult.tokensOut ?? 0,
        filesChanged: fileChanges.length, linesAdded: 0, linesRemoved: 0,
        durationMs: Math.round(performance.now() - taskStartTime),
      })
      this.scribe.completeTurn(turnId, response, this.activeTaskId)
      if (this.onTaskComplete) this.onTaskComplete(response)
      if (response) process.stdout.write(response + "\n")
      if (beeDecision.filesModified?.length) {
        log.info(`[coordinator-manager] 🐝 BEE modified: ${beeDecision.filesModified.join(", ")}`)
      }
      return
    }

    // DISPATCH: BEE decided which coordinators to use directly (no architecture phase)
    if (beeDecision.action === "dispatch" && beeDecision.phases?.length) {
      log.info(`[coordinator-manager] 🐝 BEE dispatching directly to: ${beeDecision.phases.map(p => p.coordinator).join(", ")}`)
      const dispatchPhases: ParsedPhase[] = beeDecision.phases.map(p => ({
        name: p.description,
        coordinator: p.coordinator as Exclude<PhaseName, "bee">,
        description: p.description,
        dependsOn: p.dependsOn as Array<Exclude<PhaseName, "bee">>,
      }))
      await this.executePhaseLoop(
        dispatchPhases,
        description,
        beeResult.narrativeEntry,
        undefined,
        mode,
        configuredProvider,
        configuredModel,
        onApprovalCheckpoint,
      )
      await this.finalizeTask(taskStartTime, turnId, "BEE dispatch completed")
      log.info(`[coordinator-manager] ✅ Task ${this.activeTaskId} completed (BEE dispatch)`)
      return
    }

    // ARCHITECTURE (default): Create git branch then run Architecture + specialists
    const branchName = `hivecode/task-${this.activeTaskId}`
    try {
      const gitResult = await executeToolByName(this.allTools, "git_branch", {
        action: "create",
        name: branchName,
        path: process.cwd(),
      }, { configurable: { workspace: process.cwd() } })
      if ((gitResult as any)?.ok) {
        this.scribe.updateTaskStatus(this.activeTaskId, "planning", { branchName })
        log.info(`[coordinator-manager] 🌿 Branch created: ${branchName}`)
      } else {
        log.warn(`[coordinator-manager] ⚠️  Could not create branch: ${(gitResult as any)?.error || "unknown"}`)
      }
    } catch (err) {
      log.warn(`[coordinator-manager] ⚠️  Git branch creation failed: ${(err as Error).message}`)
    }

    // ── Phase 1: Architecture ─────────────────────────────────────────────────
    const archPhaseId = this.scribe.createPhase(this.activeTaskId, "architecture", "architecture")
    const archTask: CoordinatorTask = {
      taskId: this.activeTaskId,
      phaseId: archPhaseId,
      phase: "architecture",
      description,
      narrative: beeResult.narrativeEntry,
      mode: mode ?? getMode(),
      projectPath: process.cwd(),
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
      // Print ADR to stdout so the TUI / executeTask captures it
      const lines: string[] = []
      if (plan.adr.title)        lines.push(`\n## ${plan.adr.title}\n`)
      if (plan.adr.context)      lines.push(`**Contexto:** ${plan.adr.context}\n`)
      if (plan.adr.decision)     lines.push(`**Decisión:** ${plan.adr.decision}\n`)
      if (plan.adr.consequences) lines.push(`**Consecuencias:** ${plan.adr.consequences}\n`)
      if (plan.phases.length)    lines.push(`\n**Fases:** ${plan.phases.map(p => p.coordinator).join(" → ")}\n`)
      if (plan.risks.length)     lines.push(`\n**Riesgos:**\n${plan.risks.map(r => `- [${r.severity}] ${r.description}`).join("\n")}\n`)
      const adrText = lines.join("")
      if (adrText) process.stdout.write(adrText)

      await this.finalizeTask(taskStartTime, turnId, adrText || archResult.narrativeEntry)
      return
    }

    // Execute dynamic phases from the architecture plan
    const phases = plan.phases.length > 0 ? plan.phases : getDefaultPhases()
    await this.executePhaseLoop(
      phases,
      description,
      archResult.narrativeEntry,
      plan.interfaces,
      mode,
      configuredProvider,
      configuredModel,
      onApprovalCheckpoint,
    )

    await this.finalizeTask(taskStartTime, turnId, archResult.narrativeEntry)
    log.info(`[coordinator-manager] ✅ Task ${this.activeTaskId} completed`)
  }

  /** Persist task-level metadata (tokens, files, duration) and close the turn */
  private async finalizeTask(taskStartMs: number, turnId: string, agentResponse: string): Promise<void> {
    if (!this.activeTaskId) return
    const durationMs = Math.round(performance.now() - taskStartMs)

    // Aggregate tokens from all phases
    const db = getDb()
    const totals = db.query<{ ti: number; tout: number }, [string]>(`
      SELECT COALESCE(SUM(tokens_in),0) AS ti, COALESCE(SUM(tokens_out),0) AS tout
      FROM code_task_phases WHERE task_id = ?
    `).get(this.activeTaskId) ?? { ti: 0, tout: 0 }

    // Collect git changes after task
    let fileChanges: FileChange[] = []
    try {
      const gitStat = await executeToolByName(this.allTools, "git_status", { path: process.cwd() }, { configurable: { workspace: process.cwd() } }) as any
      const changedFiles: string[] = [
        ...(gitStat?.staged ?? []),
        ...(gitStat?.unstaged ?? []),
      ].filter((v, i, a) => a.indexOf(v) === i)

      // Parse git diff --stat for line counts
      const diffStat = await executeToolByName(this.allTools, "git_diff", {
        path: process.cwd(), stat: true,
      }, { configurable: { workspace: process.cwd() } }) as any
      const diffText: string = diffStat?.diff ?? ""
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
    } catch { /* git tools optional */ }

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
    this.scribe.updateTaskStatus(this.activeTaskId, "completed")
    this.scribe.completeTurn(turnId, agentResponse, this.activeTaskId)

    if (this.onTaskComplete) {
      this.onTaskComplete(agentResponse)
    }

    broadcastTaskEnd(this.activeTaskId, "completed", durationMs)

    // ACE Reflector: auto-run every N tasks or when trace threshold is met
    incrementTaskCounter()
    if (shouldRunReflector(db)) {
      runReflector(db).then((result) => {
        if (result.rules > 0) {
          log.info(`[coordinator-manager] ACE Reflector auto-run: ${result.rules} new rules`)
        }
      }).catch((err) => {
        log.warn("[coordinator-manager] ACE Reflector auto-run failed:", (err as Error).message)
      })
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
    }) => Promise<"approve" | "skip" | "cancel">
  ): Promise<void> {
    const levels = groupPhasesByLevel(phases)

    log.info(`[coordinator-manager] 📋 Executing ${phases.length} phases in ${levels.length} level(s):`)
    for (let lvl = 0; lvl < levels.length; lvl++) {
      log.info(`[coordinator-manager]    Level ${lvl}: ${levels[lvl].map(p => p.coordinator).join(" + ")}`)
    }

    let globalPhaseIndex = 0

    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      if (isCancelled()) break

      // Track current level for worker_activity writes
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

      const levelTasks: Array<{ phase: PhaseName; task: CoordinatorTask; startedAt: number }> = levelPhases.map(phaseDef => {
        const phase = phaseDef.coordinator
        // Override model to most capable for reviewer
        const effectiveModel = phase === "reviewer" ? this.getHighestCapabilityModel() || model : model
        const task: CoordinatorTask = {
          taskId: this.activeTaskId || "current",
          phaseId: this.scribe.createPhase(this.activeTaskId || "current", phase, phase),
          phase,
          description,
          adr: archNarrative,
          interfaces,
          narrative: archNarrative || "",
          mode: phaseMode,
          projectPath: process.cwd(),
          secrets: this.secrets,
          provider: provider || undefined,
          model: effectiveModel || undefined,
        }
        this.writeWorkerActivity(phase, levelIdx, "running", 0, 0, Date.now(), null)
        return { phase, task, startedAt: Date.now() }
      })

      // Announce phase start to live feed
      for (const { phase } of levelTasks) {
        if (this.activeTaskId) broadcastPhaseStart(this.activeTaskId, phase, phase)
      }

      const results = await Promise.all(
        levelTasks.map(({ phase, task }) => this.dispatchPhase(phase, task))
      )

      for (let r = 0; r < results.length; r++) {
        const result = results[r]
        const { phase, task, startedAt } = levelTasks[r]

        // Record completion in worker_activity
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
            return
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
              return
            }
            this.scribe.updatePhaseStatus(constraintTask.phaseId, "completed", retryResult.narrativeEntry)
            this.scribe.updatePhaseMetadata(constraintTask.phaseId, retryResult.tokensIn ?? 0, retryResult.tokensOut ?? 0, retryResult.durationMs)
            continue
          }

          // Reasign: handle as regular failure
          this.scribe.updateTaskStatus(this.activeTaskId!, "failed")
          log.error(`[coordinator-manager] ❌ ${phase} phase failed (ForensicAgent recommends reasign)`)
          return
        }

        if (result.status === "failed") {
          this.scribe.updateTaskStatus(this.activeTaskId!, "failed")
          log.error(`[coordinator-manager] ❌ ${phase} phase failed: ${result.blockerDescription}`)
          return
        }

        if (result.status === "blocked") {
          this.scribe.updatePhaseStatus(task.phaseId, "blocked", result.blockerDescription)
          this.scribe.updateTaskStatus(this.activeTaskId!, "paused")
          log.warn(`[coordinator-manager] ⚠️ ${phase} phase blocked: ${result.blockerDescription}`)
          return
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
          const verdict = this.parseReviewerVerdict(result.narrativeEntry)
          if (verdict === "aprobado" || verdict === "aprobado_con_observaciones") {
            log.info(`[coordinator-manager] 📚 Reviewer approved — activating Librarian`)
            this.runLibrarianAgent(task, provider, model).catch(err => {
              log.warn(`[coordinator-manager] Librarian error: ${(err as Error).message}`)
            })
          } else {
            log.info(`[coordinator-manager] 🔄 Reviewer rejected — marking task for retry`)
            this.scribe.updateTaskStatus(this.activeTaskId!, "failed")
            return
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

        log.info(`[coordinator-manager] ✅ Level ${levelIdx} approved`)
      }

      globalPhaseIndex += levelPhases.length
    }
  }

  /** Write a row to the session DB worker_activity table for level-based tracking */
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
      const sessionDb = getSessionDb(this.activeSessionId)
      sessionDb.query(
        `INSERT INTO worker_activity (session_id, worker, phase, level, status, input_tokens, output_tokens, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(this.activeSessionId, phase, phase, level, status, tokensIn, tokensOut, startedAt, completedAt)
    } catch {
      // worker_activity is non-critical — never block on write failure
    }
  }

  /** Returns the highest-capability model ID available for the configured provider */
  private getHighestCapabilityModel(): string | null {
    try {
      const db = getDb()
      // Try to find a model tagged as top-tier; fall back to configured model
      const row = db.query<{ id: string }, []>(
        `SELECT id FROM models WHERE tier = 'top' ORDER BY id DESC LIMIT 1`
      ).get()
      return row?.id ?? null
    } catch {
      return null
    }
  }

  /** Run ForensicAgent as an on-demand temporary worker */
  private async runForensicAgent(
    failedPhase: PhaseName,
    originalTask: CoordinatorTask,
    failedResult: CoordinatorResult
  ): Promise<CoordinatorResult> {
    const taskId = this.activeTaskId || "forensic"
    const phaseId = this.scribe.createPhase(taskId, "forensic", "forensic")
    const forensicTask: CoordinatorTask = {
      taskId,
      phaseId,
      phase: "forensic",
      description: `Analyze why ${failedPhase} failed after exhausting iterations. Failed narrative: ${failedResult.narrativeEntry?.slice(0, 500)}`,
      narrative: originalTask.narrative || "",
      mode: originalTask.mode,
      projectPath: process.cwd(),
      secrets: this.secrets,
      provider: originalTask.provider,
      model: originalTask.model,
    }

    const workerPath = COORDINATOR_FILES["forensic"]
    const forensicWorker = new (Worker as any)(workerPath, { smol: true }) as Bun.Worker

    return new Promise((resolve) => {
      const resolverKey = `${taskId}:${phaseId}`
      const tools = getToolsForCoordinator("forensic" as PhaseName, this.allTools)
      const compiledContext = this.compileWorkerContext("forensic" as PhaseName, forensicTask.description, forensicTask.narrative)
      const msg: ManagerToWorkerMessage = {
        type: "TASK",
        task: { ...forensicTask, tools: tools as any, compiledContext },
      }

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

  /** Parse reviewer verdict from its narrative */
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
    const phaseId = this.scribe.createPhase(taskId, "librarian", "librarian")
    const libTask: CoordinatorTask = {
      taskId,
      phaseId,
      phase: "librarian",
      description: `Distill session knowledge into agent_memory for project: ${process.cwd()}`,
      narrative: reviewerTask.narrative || "",
      mode: reviewerTask.mode,
      projectPath: process.cwd(),
      secrets: this.secrets,
      provider: provider || undefined,
      model: model || undefined,
    }

    const workerPath = COORDINATOR_FILES["librarian"]
    const libWorker = new (Worker as any)(workerPath, { smol: true }) as Bun.Worker

    return new Promise((resolve) => {
      const tools = getToolsForCoordinator("librarian" as PhaseName, this.allTools)
      const compiledContext = this.compileWorkerContext("librarian" as PhaseName, libTask.description, libTask.narrative)
      const msg: ManagerToWorkerMessage = {
        type: "TASK",
        task: { ...libTask, tools: tools as any, compiledContext },
      }

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
        this.pendingTimeouts.delete(resolverKey)
        reject(new Error(`Worker ${phase} timed out after 5 minutes`))
      }, 300_000)
      this.pendingTimeouts.set(resolverKey, timeout)

    // Get tools for this coordinator
    const tools = getToolsForCoordinator(phase, this.allTools)

    // Compile worker context (skills, playbook, scratchpad) for this phase
    const compiledContext = this.compileWorkerContext(phase, task.description, task.narrative)

    // Send task with tools + compiled context via string fast-path (SPEC §3.1: ~500 ns latency)
    const msg: ManagerToWorkerMessage = {
      type: "TASK",
      task: { ...task, tools: tools as any, compiledContext },
    }
      worker.postMessage(JSON.stringify(msg))

  // Note: we don't set worker.onmessage here because it's already set in startAll
  // The handleWorkerMessage will call the correct resolver when it receives a RESULT
  })
  }

  /** Compile worker context: relevant skills, playbook rules, and scratchpad notes.
   *  Runs on main thread where DB is available; injects as string into CoordinatorTask. */
  private compileWorkerContext(phase: PhaseName, taskDescription: string, narrative: string): string {
    const db = getDb()
    const sections: string[] = []

    // 1. Skills — minimal + FTS5-discovered for this phase
    try {
      const minimalSkills = getMinimalSkills()
      const discoveredSkills = selectSkills(`${taskDescription} ${phase}`)
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
      const rules = db.query<any, [string]>(`
        SELECT rule, confidence FROM code_playbook
        WHERE active = 1 AND (coordinator = ? OR coordinator IS NULL)
        ORDER BY confidence DESC LIMIT 5
      `).all(phase)
      if (rules.length > 0) {
        let playbookSection = "# PLAYBOOK RULES\nFollow these verified patterns:\n\n"
        for (const r of rules) {
          playbookSection += `- [${(r.confidence * 100).toFixed(0)}%] ${r.rule}\n`
        }
        sections.push(playbookSection)
      }
    } catch {
      // code_playbook may not have rows yet — skip silently
    }

    // 3. Agent memory from previous sessions (FTS5-filtered by relevance)
    try {
      const memRepo = new MemoryRepo()
      const projectId = process.cwd()
      const memories = memRepo.searchByRelevance(projectId, `${taskDescription} ${phase}`, 8)
      if (memories.length > 0) {
        let memSection = "# PROJECT MEMORY (from previous sessions)\nKnowledge accumulated by the swarm:\n\n"
        for (const m of memories) {
          memSection += `[${m.type}|${m.severity}] ${m.content}\n`
          memRepo.updateLastUsed(m.id)
        }
        sections.push(memSection)
      }
    } catch {
      // memory.db may not be initialized in test/worker context — skip silently
    }

    // 4. Recent scratchpad / narrative context
    if (narrative) {
      sections.push(`# PROJECT NARRATIVE\n${narrative}`)
    }

    return sections.join("\n\n")
  }

  private handleWorkerMessage(name: PhaseName, rawMsg: WorkerToManagerMessage | string): void {
    const msg = typeof rawMsg === "string" ? JSON.parse(rawMsg) as WorkerToManagerMessage : rawMsg
    if (msg.type === "RESULT" && msg.result) {
      // NOTE: We intentionally do NOT emit onNarrativeChunk here for the final
      // agent response, because the caller (executeTask via runTask) already
      // captures stdout and sends a HistoryAppend to the TUI. Emitting here
      // would duplicate the message. Tool calls still stream in real-time
      // via handleToolCall → onNarrativeChunk.

      // Format BEE's JSON output for WebSocket subscribers
      let displayContent = msg.result.narrativeEntry
      if (name === "bee" && msg.result.narrativeEntry) {
        displayContent = formatBeeNarrative(msg.result.narrativeEntry)
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
        resolver(msg.result)
        this.pendingResolvers.delete(resolverKey)
      }
      const idx = COORDINATOR_NAMES.indexOf(name)
      setWorkerBusy(idx, false)
      return
    }

    if (msg.type === "THINKING" && msg.content) {
      if (this.onNarrativeChunk) {
        this.onNarrativeChunk({
          coordinator: name,
          phase: "thinking",
          content: msg.content,
          streamId: (msg as any).streamId,
        })
      }
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

    // Stream tool call to TUI so user sees what the agent is doing
    if (this.onNarrativeChunk) {
      const humanDesc = formatToolCallForHuman(msg.toolName, msg.toolArgs || {})
      this.onNarrativeChunk({
        coordinator: name,
        phase: msg.toolName || name,
        content: humanDesc,
        streamId: msg.toolCallId,
      })
    }


    // Check plan mode gate
    const mode = getMode()
    if (mode === "plan") {
      const planBlockedTools = new Set([
        "fs_write", "fs_edit", "fs_delete",
        "git_commit", "git_branch", "git_create_pr", "git_rollback",
        "append_narrative", "write_decision",
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

    // Conflict detection + checkpoint before write operations
    const writeTools = new Set(["fs_write", "fs_edit", "fs_delete"])
    if (writeTools.has(msg.toolName) && msg.toolArgs) {
      const filePath = (msg.toolArgs.path as string) || (msg.toolArgs.file as string) || ""
      if (filePath) {
        // 1. Check blackboard for write conflicts
        const canWrite = await this.checkWriteConflicts(name, filePath)
        if (!canWrite) {
          const errorMsg = `[CONFLICT] Another agent is writing to ${filePath}. Retry in a moment.`
          log.warn(`[coordinator-manager] ⚠️ Conflict blocked ${name} from writing ${filePath}`)
          this.writeToolTrace(name, msg.toolName, JSON.stringify(msg.toolArgs), errorMsg, false, 0n)
          worker.postMessage(JSON.stringify({
            type: "TOOL_RESULT",
            toolCallId: msg.toolCallId,
            error: errorMsg,
          } as ManagerToWorkerMessage))
          return
        }
        // 2. Create checkpoint before mutating
        const op = msg.toolName === "fs_delete" ? "deleted" : "modified"
        if (this.activeTaskId) {
          const existingPaths = op !== "deleted" ? [filePath] : []
          const newPaths     = op === "deleted"   ? []         : []
          await this.checkpoint(`before ${msg.toolName} ${filePath}`, existingPaths, newPaths, name)
        }
      }
    }

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
        const cmdValidation = validateCommand(shellCmd, { workspace: process.cwd(), mode })
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

    // Execute the tool with timing (Heavy tools go to the worker pool)
    const inputSummary = JSON.stringify(msg.toolArgs || {}).slice(0, 2000)
    const toolStart = performance.now()
    
    const heavyTools = new Set(["code_search", "parse_ast", "check_types", "code_build", "code_test", "code_lint", "shell_executor"])
    let result: any

    if (heavyTools.has(msg.toolName!)) {
      result = await this.executeInToolWorker(msg.toolName!, msg.toolArgs || {}, { configurable: { workspace: process.cwd() } })
    } else {
      result = await executeToolByName(
        this.allTools,
        msg.toolName!,
        msg.toolArgs || {},
        { configurable: { workspace: process.cwd() } }
      )
    }
    
    const toolDurationNs = BigInt(Math.round((performance.now() - toolStart) * 1_000_000))
    const success = !(result && typeof result === "object" && "ok" in (result as any) && (result as any).ok === false)
    const outputSummary = typeof result === "string" ? result.slice(0, 2000) : JSON.stringify(result).slice(0, 2000)

    // Write tool execution trace (SPEC §5.4)
    this.writeToolTrace(name, msg.toolName, inputSummary, outputSummary, success, toolDurationNs)

    // Evaluate file risk after a successful write so TUI can show risk badges
    if (success && writeTools.has(msg.toolName!) && msg.toolArgs) {
      const riskFilePath = (msg.toolArgs.path as string) || (msg.toolArgs.file as string) || ""
      if (riskFilePath) {
        const riskOp = msg.toolName === "fs_delete"
          ? "deleted"
          : msg.toolName === "fs_write" ? "created" : "modified"
        this.evaluateFileRisk(riskFilePath, riskOp as "created" | "modified" | "deleted", name)
      }
    }

    // Stream tool result to TUI so user sees success/failure — use human-readable format
    if (this.onNarrativeChunk) {
      const formattedForHuman = formatToolResult(msg.toolName, result)
      this.onNarrativeChunk({
        coordinator: name,
        phase: msg.toolName,
        content: formattedForHuman,
        streamId: msg.toolCallId,
      })
    }


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

  setNarrativeCallback(cb: (chunk: { coordinator: string; phase: string; content: string }) => void): void {
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
