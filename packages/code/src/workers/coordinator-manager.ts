import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
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

const log = logger.child("coordinator-manager")

/** Parse `git diff --stat` text into per-file line counts */
function parseGitDiffStat(stat: string): Record<string, { added: number; removed: number }> {
  const result: Record<string, { added: number; removed: number }> = {}
  for (const line of stat.split("\n")) {
    // Format: " src/foo.ts | 12 +++---"
    const m = line.match(/^\s+(.+?)\s+\|\s+\d+\s+([+\-]+)/)
    if (!m) continue
    const file = m[1].trim()
    const symbols = m[2]
    result[file] = {
      added:   (symbols.match(/\+/g) ?? []).length,
      removed: (symbols.match(/-/g)  ?? []).length,
    }
  }
  return result
}

/** Extract and parse BEE's JSON routing decision from its narrative output */
function parseBeeDecision(raw: string): import("./types").BeeDecision {
  if (!raw || !raw.trim()) {
    return { action: "respond", content: "", reason: "Empty response from LLM" }
  }

  // Strategy 1: Extract JSON from markdown code blocks (```json ... ```)
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (codeBlockMatch) {
    try {
      const data = JSON.parse(codeBlockMatch[1])
      return {
        action: data.action || "architecture",
        content: data.content,
        reason: data.reason || "",
        phases: data.phases,
        filesModified: data.filesModified,
        harness: data.harness,
      }
    } catch {
      // JSON in code block failed — try to repair common issues
      const repaired = repairJson(codeBlockMatch[1])
      if (repaired) {
        try {
          const data = JSON.parse(repaired)
          return {
            action: data.action || "architecture",
            content: data.content,
            reason: data.reason || "",
            phases: data.phases,
            filesModified: data.filesModified,
            harness: data.harness,
          }
        } catch {
          // Repaired JSON still failed — fall through
        }
      }
    }
  }

  // Strategy 2: Find the last top-level JSON object (greedy match for closing brace)
  const jsonObjMatch = raw.match(/\{[\s\S]*"action"[\s\S]*\}/)
  if (jsonObjMatch) {
    try {
      const data = JSON.parse(jsonObjMatch[0])
      return {
        action: data.action || "architecture",
        content: data.content,
        reason: data.reason || "",
        phases: data.phases,
        filesModified: data.filesModified,
        harness: data.harness,
      }
    } catch {
      const repaired = repairJson(jsonObjMatch[0])
      if (repaired) {
        try {
          const data = JSON.parse(repaired)
          return {
            action: data.action || "architecture",
            content: data.content,
            reason: data.reason || "",
            phases: data.phases,
            filesModified: data.filesModified,
            harness: data.harness,
          }
        } catch {
          // Repaired JSON still failed — fall through
        }
      }
    }
  }

  // Strategy 3: Try to parse the entire response as JSON
  try {
    const data = JSON.parse(raw)
    return {
      action: data.action || "architecture",
      content: data.content,
      reason: data.reason || "",
      phases: data.phases,
      filesModified: data.filesModified,
      harness: data.harness,
    }
  } catch {
    // Not JSON at all
  }

  // Strategy 4: BEE returned plain text — treat as a direct response to the user
  return { action: "respond", content: raw.trim(), reason: "BEE returned non-JSON response" }
}

/** Attempt to repair common JSON issues from LLM output */
function repairJson(input: string): string | null {
  let s = input.trim()
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1")
  // Add missing closing braces/brackets
  const opens = (s.match(/{/g) || []).length
  const closes = (s.match(/}/g) || []).length
  if (opens > closes) s += "}".repeat(opens - closes)
  const openBrackets = (s.match(/\[/g) || []).length
  const closeBrackets = (s.match(/]/g) || []).length
  if (openBrackets > closeBrackets) s += "]".repeat(openBrackets - closeBrackets)
  return s
}

/** Format BEE's raw JSON output into a human-readable narrative entry */
/** Convert a tool call into a human-readable description */
function formatToolCallForHuman(toolName: string, args: Record<string, unknown>): string {
  const path = (args.path as string) || (args.file as string) || ""
  const cmd = (args.cmd as string) || (args.command as string) || ""
  const query = (args.query as string) || (args.pattern as string) || ""
  switch (toolName) {
    case "fs_read":
      return `📄 Leyendo archivo${path ? ": " + path : ""}`
    case "fs_list":
      return `📁 Explorando directorio${path ? ": " + path : ""}`
    case "fs_exists":
      return `🔍 Verificando existencia${path ? ": " + path : ""}`
    case "fs_glob":
      return `🌐 Buscando archivos${(args.pattern as string) ? ": " + args.pattern : ""}`
    case "fs_write":
      return `✏️  Escribiendo archivo${path ? ": " + path : ""}`
    case "fs_edit":
      return `✏️  Editando archivo${path ? ": " + path : ""}`
    case "fs_delete":
      return `🗑️  Eliminando archivo${path ? ": " + path : ""}`
    case "shell_executor":
      return `⚡ Ejecutando${cmd ? ": " + cmd.slice(0, 60) : ""}`
    case "code_search":
      return `🔍 Buscando código${query ? ": " + query.slice(0, 60) : ""}`
    case "parse_ast":
      return `🌳 Analizando AST${path ? ": " + path : ""}`
    case "git_status":
      return `📊 Estado del repositorio`
    case "git_diff":
      return `📋 Diff del repositorio`
    case "git_log":
      return `📜 Historial de commits`
    case "git_branch":
      return `🌿 Gestionando ramas`
    case "git_commit":
      return `💾 Commit de cambios`
    case "check_types":
      return `🔎 Verificando tipos`
    case "code_build":
      return `🏗️  Compilando proyecto`
    case "code_test":
      return `🧪 Ejecutando tests`
    case "code_lint":
      return `🧹 Linting`
    case "read_narrative":
      return `📖 Leyendo narrativa`
    case "write_decision":
      return `📝 Registrando decisión`
    case "append_narrative":
      return `📝 Actualizando narrativa`
    case "run_script":
      return `▶️  Ejecutando script`
    case "browser_screenshot":
      return `🖼️  Capturando pantalla${(args.url as string) ? ": " + args.url : ""}`
    case "web_search":
      return `🌐 Buscando web${query ? ": " + query.slice(0, 60) : ""}`
    case "web_fetch":
      return `🌐 Fetching${(args.url as string) ? ": " + args.url : ""}`
    default:
      return `🔧 ${toolName}`
  }
}

/** Format a tool result into a human-readable <system> message for the LLM.
 *  Inspired by Kimi CLI's tool_result_to_message().
 */
// Smart truncation: show head + tail for large outputs (like OpenHands/Cline)
// Keeps the beginning (context) and the end (most relevant recent output)
const MAX_DISPLAY_CHARS = 10_000
const MAX_DISPLAY_LINES = 500
function smartTruncate(text: string, maxChars = MAX_DISPLAY_CHARS): string {
  if (text.length <= maxChars) return text
  const headLen = Math.floor(maxChars * 0.3)
  const tailLen = Math.floor(maxChars * 0.7)
  return text.slice(0, headLen) + `\n... [${text.length - headLen - tailLen} chars omitted] ...\n` + text.slice(-tailLen)
}

function smartTruncateLines(text: string, maxLines = MAX_DISPLAY_LINES): string {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return text
  const headLines = Math.floor(maxLines * 0.3)
  const tailLines = Math.floor(maxLines * 0.7)
  const head = lines.slice(0, headLines).join("\n")
  const tail = lines.slice(-tailLines).join("\n")
  return head + `\n... [${lines.length - headLines - tailLines} lines omitted] ...\n` + tail
}

function formatToolResult(toolName: string, result: unknown): string {
  const isError = result && typeof result === "object" && "ok" in (result as any) && (result as any).ok === false
  const errorMsg = isError ? (result as any).error || "Unknown error" : ""

  if (isError) {
    return `<system>\n❌ [${toolName}]: ${errorMsg}\n</system>`
  }

  // Build human-readable summary based on tool type
  let summary = ""
  const r = result as any

  switch (toolName) {
    case "fs_list": {
      const count = r?.count ?? r?.entries?.length ?? 0
      summary = `✅ [${toolName}]: ${count} entries in ${r?.path || "."}`
      if (r?.entries && Array.isArray(r.entries)) {
        const lines = r.entries.map((e: any) => {
          const size = e.size ? ` (${Math.round(e.size / 1024)}KB)` : ""
          return `  ${e.type === "directory" ? "📁" : "📄"} ${e.name}${size}`
        })
        summary += "\n" + smartTruncateLines(lines.join("\n"))
      }
      break
    }
    case "fs_read": {
      const linesRead = r?.linesRead ?? 0
      const totalLines = r?.totalLines ?? 0
      summary = `✅ [${toolName}]: ${r?.path || "file"} (${linesRead}/${totalLines} lines)`
      if (r?.content) {
        summary += "\n```\n" + smartTruncate(String(r.content)) + "\n```"
      }
      break
    }
    case "fs_exists": {
      summary = `✅ [${toolName}]: ${r?.path || ""} ${r?.exists ? "exists" : "does not exist"}`
      break
    }
    case "fs_glob": {
      const matches = r?.matches || r?.files || []
      summary = `✅ [${toolName}]: ${matches.length} matches${r?.pattern ? ` for "${r.pattern}"` : ""}`
      if (matches.length > 0) {
        summary += "\n" + smartTruncateLines(matches.map((f: string) => `  ${f}`).join("\n"))
      }
      break
    }
    case "shell_executor": {
      const exitCode = r?.exitCode ?? 0
      const elapsed = r?.executionTimeMs ?? 0
      summary = `${exitCode === 0 ? "✅" : "⚠️"} [${toolName}]: ${r?.command || ""} (exit=${exitCode}, ${elapsed}ms)`
      if (r?.stdout) {
        summary += "\nstdout:\n```\n" + smartTruncate(smartTruncateLines(String(r.stdout))) + "\n```"
      }
      if (r?.stderr) {
        summary += "\nstderr:\n```\n" + smartTruncate(smartTruncateLines(String(r.stderr))) + "\n```"
      }
      break
    }
    case "code_search": {
      const matches = r?.matches || []
      summary = `✅ [${toolName}]: ${matches.length} matches${r?.query ? ` for "${r.query}"` : ""}`
      if (matches.length > 0) {
        summary += "\n" + smartTruncateLines(matches.map((m: any) => `  ${m.file}:${m.line}: ${m.text || ""}`).join("\n"))
      }
      break
    }
    case "git_status": {
      const staged = r?.staged || []
      const unstaged = r?.unstaged || []
      summary = `✅ [${toolName}]: ${staged.length} staged, ${unstaged.length} unstaged`
      if (staged.length) summary += "\nstaged:\n" + staged.map((f: string) => `  ${f}`).join("\n")
      if (unstaged.length) summary += "\nunstaged:\n" + unstaged.map((f: string) => `  ${f}`).join("\n")
      break
    }
    case "git_diff": {
      summary = `✅ [${toolName}]: diff retrieved${r?.path ? ` for ${r.path}` : ""}`
      if (r?.diff) {
        summary += "\n```diff\n" + smartTruncate(smartTruncateLines(String(r.diff))) + "\n```"
      }
      break
    }
    case "git_log": {
      const commits = r?.commits || []
      summary = `✅ [${toolName}]: ${commits.length} commits`
      if (commits.length > 0) {
        summary += "\n" + commits.map((c: any) => `  ${c.hash?.slice(0, 7) || ""} — ${c.message || ""}`).join("\n")
      }
      break
    }
    case "parse_ast": {
      summary = `✅ [${toolName}]: AST parsed for ${r?.file || r?.path || "file"}`
      if (r?.summary) summary += `\n${r.summary}`
      break
    }
    case "check_types": {
      summary = `${r?.ok ? "✅" : "⚠️"} [${toolName}]: type check ${r?.ok ? "passed" : "failed"}`
      if (r?.errors?.length) summary += "\n" + r.errors.map((e: string) => `  ${e}`).join("\n")
      break
    }
    case "code_build":
    case "code_test":
    case "code_lint": {
      summary = `${r?.ok ? "✅" : "⚠️"} [${toolName}]: ${r?.ok ? "success" : "failed"}`
      if (r?.output) {
        summary += "\n```\n" + smartTruncate(smartTruncateLines(String(r.output))) + "\n```"
      }
      break
    }
    case "browser_screenshot": {
      summary = `${r?.ok ? "✅" : "❌"} [${toolName}]: ${r?.url || ""}`
      if (r?.path) summary += `\nScreenshot saved to: ${r.path}`
      if (r?.error) summary += `\nError: ${r.error}`
      break
    }
    case "web_search": {
      const results = r?.results || []
      summary = `✅ [${toolName}]: ${results.length} results${r?.query ? ` for "${r.query}"` : ""}`
      if (results.length > 0) {
        summary += "\n" + results.map((res: any, i: number) =>
          `  ${i + 1}. ${res.title || ""}\n     ${res.url || ""}\n     ${res.snippet || ""}`
        ).join("\n")
      }
      break
    }
    case "web_fetch": {
      summary = `✅ [${toolName}]: fetched ${r?.url || ""}`
      if (r?.title) summary += `\nTitle: ${r.title}`
      if (r?.content) {
        summary += "\n```\n" + smartTruncate(String(r.content)) + "\n```"
      }
      break
    }
    default:
      // Generic fallback
      const generic = typeof result === "string" ? result : JSON.stringify(result, null, 2)
      summary = `✅ [${toolName}]: result\n\`\`\`\n${smartTruncate(generic)}\n\`\`\``
  }

  return `<system>\n${summary}\n</system>`
}

function formatBeeNarrative(raw: string): string {
  const decision = parseBeeDecision(raw)
  switch (decision.action) {
    case "respond":
      return decision.content || "BEE respondió directamente."
    case "fix":
      return decision.content || "BEE aplicó un fix directo."
    case "dispatch": {
      const coords = decision.phases?.map(p => p.coordinator).join(", ") || ""
      return `BEE delegó a: ${coords}\n${decision.reason}`
    }
    case "architecture":
      return `BEE decidió diseño arquitectónico\n${decision.reason}`
    default:
      return raw
  }
}

// BEE is index 0 in the bitmask; coordinators follow at indices 1-6
const COORDINATOR_NAMES: PhaseName[] = [
  "bee", "architecture", "backend", "frontend", "security", "test", "devops",
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
}

export class CoordinatorManager {
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
  private idleToolWorkers: Bun.Worker[] = []
  private toolResolvers = new Map<string, (res: any) => void>()
  private onNarrativeChunk?: (chunk: { coordinator: string; phase: string; content: string; streamId?: string }) => void
  private onWorkerUpdate?: (update: { type: "tool_worker"; id: number; status: "idle" | "busy"; tool?: string }) => void

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
        this.scribe.saveRecoveryPoint(this.activeTaskId, null, completedPhaseIds, pendingPhaseIds)
      }

      const levelTasks: Array<{ phase: PhaseName; task: CoordinatorTask }> = levelPhases.map(phaseDef => {
        const phase = phaseDef.coordinator
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
          model: model || undefined,
        }
        return { phase, task }
      })

      // Announce phase start to live feed
      for (const { phase, task: t } of levelTasks) {
        if (this.activeTaskId) broadcastPhaseStart(this.activeTaskId, phase, phase)
      }

      const results = await Promise.all(
        levelTasks.map(({ phase, task }) => this.dispatchPhase(phase, task))
      )

      for (let r = 0; r < results.length; r++) {
        const result = results[r]
        const { phase, task } = levelTasks[r]

        this.scribe.appendNarrative({
          taskId: this.activeTaskId!,
          sessionId: this.activeSessionId!,
          coordinator: result.coordinator,
          phase,
          entry: result.narrativeEntry || result.blockerDescription || "",
          isDraft: false,
          isOverride: false,
        })

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

    // 3. Recent scratchpad / narrative context
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

  setNarrativeCallback(cb: (chunk: { coordinator: string; phase: string; content: string }) => void): void {
    this.onNarrativeChunk = cb
  }

  setWorkerUpdateCallback(cb: (update: { type: "tool_worker"; id: number; status: "idle" | "busy"; tool?: string }) => void): void {
    this.onWorkerUpdate = cb
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
