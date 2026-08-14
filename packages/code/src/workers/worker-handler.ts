import { callLLM } from "@johpaz/hivecode-core/agent/llm-client"
import type { LLMMessage, LLMToolDef, LLMToolCall } from "@johpaz/hivecode-core/agent/llm-client"
import { readWorkerSecrets } from "./secrets"
import { getSubAgent, isValidSubAgent, SUBAGENT_WORKER_PATH } from "./subagent-registry"
import type {
  CoordinatorTask, CoordinatorResult,
  WorkerToManagerMessage, ManagerToWorkerMessage,
} from "./types"

declare var self: {
  onmessage: ((event: { data: ManagerToWorkerMessage | string }) => void) | null
  postMessage(message: WorkerToManagerMessage | string): void
}

const COORDINATOR_PROVIDER = process.env.HIVE_COORDINATOR_PROVIDER || "anthropic"
const COORDINATOR_MODEL = process.env.HIVE_COORDINATOR_MODEL || "claude-sonnet-4-6"
const MAX_ITERATIONS = 40

/** Approximate max context tokens by model name (used for compaction) */
function getMaxContextTokens(model: string): number {
  const m = model.toLowerCase()
  if (m.includes("gemini-3-flash") || m.includes("gemini-2.5-flash")) return 1_000_000
  if (m.includes("gemini-3-pro") || m.includes("gemini-2.5-pro")) return 2_000_000
  if (m.includes("gemini")) return 1_000_000
  if (m.includes("claude-sonnet-4")) return 200_000
  if (m.includes("claude-sonnet-3-7")) return 200_000
  if (m.includes("claude-sonnet")) return 200_000
  if (m.includes("claude-opus")) return 200_000
  if (m.includes("claude-haiku")) return 200_000
  if (m.includes("claude")) return 200_000
  if (m.includes("gpt-4o")) return 128_000
  if (m.includes("gpt-4-turbo")) return 128_000
  if (m.includes("gpt-4")) return 8_192
  if (m.includes("gpt-3.5")) return 16_385
  if (m.includes("llama")) return 128_000
  if (m.includes("qwen")) return 128_000
  if (m.includes("deepseek")) return 64_000
  // Default conservative fallback
  return 32_000
}

/** Estimate token count from messages (approx: 3.5 chars/token for mixed en/es/code) */
function estimateTokenCount(messages: LLMMessage[]): number {
  let totalChars = 0
  for (const msg of messages) {
    totalChars += msg.role.length
    if (typeof msg.content === "string") {
      totalChars += msg.content.length
    } else if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        totalChars += tc.function.name.length
        totalChars += (tc.function.arguments || "").length
      }
    }
  }
  return Math.ceil(totalChars / 3.5)
}

const PRUNE_TRIGGER_RATIO = 0.6
const PRUNE_KEEP_VERBATIM = 6
const PRUNE_PLACEHOLDER_LEN = 200

/**
 * Fine-grained pruning of old tool_result content — a cheaper first line of
 * defense than full compaction, applied at a lower threshold. Mirrors Anthropic's
 * "context editing" pattern (trim tool_result bodies, keep everything else):
 * the last PRUNE_KEEP_VERBATIM tool messages stay untouched; older ones are
 * replaced with a short placeholder that says what was pruned, not silently
 * dropped, so the model knows content was removed rather than never existed.
 * Runs before compactMessagesIfNeeded so most sessions never need the heavier,
 * structure-changing compaction below at all.
 */
export function pruneOldToolResults(messages: LLMMessage[], model: string): LLMMessage[] {
  const maxTokens = getMaxContextTokens(model)
  const triggerTokens = Math.floor(maxTokens * PRUNE_TRIGGER_RATIO)
  if (estimateTokenCount(messages) <= triggerTokens) return messages

  const toolIndexes = messages.reduce<number[]>((acc, m, i) => {
    if (m.role === "tool" && typeof m.content === "string" && !m.content.startsWith("[pruned:")) acc.push(i)
    return acc
  }, [])
  const prunable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - PRUNE_KEEP_VERBATIM))
  if (prunable.length === 0) return messages

  return messages.map((m, i) => {
    if (!prunable.includes(i) || typeof m.content !== "string") return m
    const originalLen = m.content.length
    if (originalLen <= PRUNE_PLACEHOLDER_LEN) return m
    return {
      ...m,
      content: `[pruned: ${originalLen} chars of an earlier tool result — see the assistant's next message for what was done with it]\n${m.content.slice(0, PRUNE_PLACEHOLDER_LEN)}...`,
    }
  })
}

/**
 * Compact tool messages if context exceeds trigger ratio.
 * Preserves: system prompt, initial user message, last 4 messages, and any assistant messages.
 * Compacts: older tool messages into a single summary.
 */
function compactMessagesIfNeeded(messages: LLMMessage[], model: string): LLMMessage[] {
  const maxTokens = getMaxContextTokens(model)
  const triggerTokens = Math.floor(maxTokens * 0.75)
  const currentTokens = estimateTokenCount(messages)

  if (currentTokens <= triggerTokens) {
    return messages // No compaction needed
  }

  // We need to compact. Strategy:
  // - Always keep first message (system) and second (initial user)
  // - Keep last 4 messages (recent context)
  // - Compact middle tool messages into a summary
  const keepCount = Math.max(2, Math.min(4, Math.floor(messages.length * 0.3)))
  const head = messages.slice(0, 2) // system + initial user
  const tail = messages.slice(-keepCount) // recent context
  const middle = messages.slice(2, -keepCount)

  if (middle.length === 0) {
    return messages // Nothing to compact
  }

  // Count tool messages in the middle
  const toolMsgs = middle.filter(m => m.role === "tool")
  if (toolMsgs.length === 0) {
    return messages // No tool messages to compact
  }

  // Build a compact summary of middle tool results
  const compactedTools = toolMsgs.slice(-3) // Keep last 3 tool results from middle
  const droppedCount = toolMsgs.length - compactedTools.length

  let summary = `📦 ${toolMsgs.length} tool results compacted to save context.`
  if (droppedCount > 0) {
    summary += ` ${droppedCount} older results summarized.`
  }
  for (const tm of compactedTools) {
    const content = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content)
    summary += "\n" + content
  }

  const compactedMessage: LLMMessage = {
    role: "user" as any,
    content: `<system>\n${summary}\n</system>`,
  }

  // Build result: head + non-tool middle messages + compacted summary + tail
  const nonToolMiddle = middle.filter(m => m.role !== "tool")
  const result = [...head, ...nonToolMiddle, compactedMessage, ...tail]

  const newTokens = estimateTokenCount(result)
  // Safety: if still too large, truncate the compacted message content
  if (newTokens > triggerTokens && compactedMessage.content) {
    const maxCompactLen = 1500
    compactedMessage.content = (compactedMessage.content as string).slice(0, maxCompactLen) + "\n...(truncated)\n</system>"
  }

  return result
}

/** Resolve API key using getEnvironmentData → task.secrets → env fallback.
 *  Each provider uses its own independent key — no sharing between providers. */
function resolveApiKey(provider: string, taskSecrets?: Record<string, string>): string {
  const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`
  const envSecrets = readWorkerSecrets()
  if (envSecrets?.[envKey]) return envSecrets[envKey]
  if (envSecrets?.["LLM_API_KEY"]) return envSecrets["LLM_API_KEY"]
  if (taskSecrets?.[envKey]) return taskSecrets[envKey]
  if (taskSecrets?.["LLM_API_KEY"]) return taskSecrets["LLM_API_KEY"]
  const envValue = process.env[envKey] || process.env.LLM_API_KEY || ""
  if (envValue) return envValue
  throw new Error(`No API key found for provider "${provider}"`)
}

/** Build system prompt for a coordinator with tool instructions */
function buildSystemPrompt(basePrompt: string, coordinatorName: string): string {
  return `${basePrompt}

---

You are running inside a Hive-Code worker as the ${coordinatorName} coordinator.
You have access to tools via function calls, and you can spawn specialized sub-agents.

RULES FOR TOOL USE:
1. You can call one or more tools in a single response.
2. After calling tools, you will receive their results and can continue reasoning.
3. In PLAN mode, write tools are disabled — you can only read and analyze.
4. Always verify files exist before writing or editing.
5. After making changes, narrate what you did and why.
6. CRITICAL: You MUST produce a FINAL text response (without tool calls) to complete your task. Do NOT keep calling tools indefinitely.
   - After 3-5 tool calls, evaluate if you have enough information to respond. If yes, respond immediately.
   - If you find yourself calling tools just to "explore more", STOP and respond with what you know.
   - A task like "hola" or a simple question should be answered in 0-1 tool calls, NEVER 20.
   - When you see ⚠️ STOPPING signal, you MUST respond immediately without any more tool calls.

DYNAMIC TOOL DISCOVERY:
- You start with a MINIMAL toolset: get_project_context, search_knowledge, fs_read, shell_executor, save_note, notify, report_progress.
- ALWAYS call get_project_context() FIRST before exploring — it gives you the global project summary (structure, key modules, ADRs).
- To discover additional tools (fs_write, fs_edit, code_build, git_commit, etc.), call:
  search_knowledge(type="tools", query="<what you need>")
- The discovered tools will be AUTOMATICALLY added to your available tools after the search.
- To discover skills: search_knowledge(type="skills", query="<what you need>")
- To search the project codebase: search_knowledge(type="code", query="<function or class name>")
- ALWAYS search for tools before trying to use tools that are not in your initial set.

SPAWNING SUB-AGENTS:
As the team lead, you may delegate work to specialized sub-agents using spawn_subagent.
- Only spawn sub-agents relevant to your domain
- You may spawn multiple sub-agents in parallel when they have no dependencies
- Wait for all sub-agents to complete before proceeding
- Sub-agents do NOT have access to tools — they only generate code/text
- Integrate their outputs into your final narrative

Available sub-agents for your domain:
${getSubAgentList(coordinatorName)}

When you are done, provide a final response without tool calls.
Your final response will be stored as the narrative entry for this phase.

Coordinator: ${coordinatorName}
`
}

/** Get formatted list of sub-agents for a coordinator */
function getSubAgentList(coordinatorName: string): string {
  const { listSubAgents } = require("./subagent-registry")
  const agents = listSubAgents(coordinatorName)
  if (agents.length === 0) return "  (none)"
  return agents.map((a: any) => ` - ${a.name}: ${a.description}`).join("\n")
}

/** Tool definition for spawn_subagent */
const SPAWN_SUBAGENT_TOOL: LLMToolDef = {
  type: "function",
  function: {
    name: "spawn_subagent",
    description: "Spawn a specialized sub-agent to handle a specific sub-task. You are the team lead — delegate work to your sub-agents when beneficial.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Name of the sub-agent to spawn (e.g., 'api-agent', 'db-agent', 'component-agent')",
        },
        task: {
          type: "string",
          description: "Specific sub-task description for the sub-agent. Be clear and focused.",
        },
      },
      required: ["agent", "task"],
    },
  },
}

/** Tool definition for BEE's routing decision */
const BEE_DECISION_TOOL: LLMToolDef = {
  type: "function",
  function: {
    name: "bee_make_decision",
    description: "Submit your final routing decision for the user's request. Call this ONLY when you have finished analyzing and are ready to deliver your structured decision. You may reason in free text before calling this tool.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["respond", "fix", "architecture", "dispatch"],
          description: "Routing action: respond=direct answer, fix=apply code fix, architecture=design multi-module plan, dispatch=delegate to specialists",
        },
        content: {
          type: "string",
          description: "Direct answer or summary of fix applied. Required for 'respond' and 'fix'.",
        },
        reason: {
          type: "string",
          description: "One-line explanation of why you made this decision.",
        },
        phases: {
          type: "array",
          description: "Phases to dispatch. Required for 'dispatch' action.",
          items: {
            type: "object",
            properties: {
              coordinator: { type: "string", description: "Coordinator to dispatch to (e.g. backend, frontend, test, security, devops)" },
              description: { type: "string", description: "What this coordinator should do, in 1-2 sentences" },
              dependsOn: { type: "array", items: { type: "string" }, description: "Coordinators that must complete before this one" },
            },
            required: ["coordinator", "description"],
          },
        },
        filesModified: {
          type: "array",
          items: { type: "string" },
          description: "Files modified directly. Required for 'fix' action.",
        },
        harness: {
          type: "string",
          description: "Structured harness document. Required in plan/approval modes for dispatch/architecture actions.",
        },
      },
      required: ["action", "reason"],
    },
  },
}

/** Tool definition for Architecture plan submission */
const ARCHITECTURE_PLAN_TOOL: LLMToolDef = {
  type: "function",
  function: {
    name: "create_architecture_plan",
    description: "Submit the final architecture plan with ADR, phases, risks, and interfaces. Call this ONLY when you have completed the analysis and design. You may reason in free text before calling this tool.",
    parameters: {
      type: "object",
      properties: {
        adr: {
          type: "object",
          description: "Architecture Decision Record",
          properties: {
            title: { type: "string" },
            context: { type: "string" },
            options: { type: "string" },
            decision: { type: "string" },
            consequences: { type: "string" },
          },
          required: ["title", "context", "options", "decision", "consequences"],
        },
        phases: {
          type: "array",
          description: "Implementation phases",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              coordinator: { type: "string", description: "product_manager|backend|frontend|data_scientist|security|test|devops|verifier|reviewer" },
              description: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" } },
            },
            required: ["name", "coordinator", "description"],
          },
        },
        risks: {
          type: "array",
          description: "Identified risks",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
              description: { type: "string" },
            },
            required: ["severity", "description"],
          },
        },
        interfaces: {
          type: "string",
          description: "TypeScript interface contracts between modules (optional)",
        },
      },
      required: ["adr", "phases"],
    },
  },
}

/** Tool definition for the CodeReviewer's structured verdict (replaces free-text string-matching). */
const REVIEW_VERDICT_TOOL: LLMToolDef = {
  type: "function",
  function: {
    name: "submit_review_verdict",
    description:
      "Submit the final review verdict. Call this ONLY after checking every PRD acceptance criterion against real evidence " +
      "(code_test/check_types results, not assumption) and cross-checking module contracts (endpoints vs consumption, schema vs queries, types vs imports). " +
      "You may reason in free text before calling this tool.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["aprobado", "aprobado_con_observaciones", "rechazado"] },
        criteria: {
          type: "array",
          description: "One entry per PRD acceptance criterion, cross-checked against real evidence — not the reviewer's assumption.",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              met: { type: "boolean" },
              evidence: { type: "string", description: "What was actually run/checked to decide met/not-met (test name, file:line, command output)." },
            },
            required: ["description", "met"],
          },
        },
        categories: {
          type: "array",
          description: "coherencia_adr | consistencia_modulos | calidad_codigo | security_findings | test_coverage | antipatrones",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: { type: "string", enum: ["ok", "warning", "blocking"] },
              detail: { type: "string" },
            },
            required: ["name", "status"],
          },
        },
        reasons: {
          type: "string",
          description: "Specific reasons with file:line. Required when verdict is 'rechazado'. If a test was weakened/removed to force a pass, that is itself a blocking reason.",
        },
      },
      required: ["verdict", "criteria"],
    },
  },
}

const DECISION_TOOL_NAMES = ["bee_make_decision", "create_architecture_plan", "submit_review_verdict"]

class WorkerAgent {
  private coordinatorName: string
  private systemPrompt: string
  private task: CoordinatorTask | null = null
  private messages: LLMMessage[] = []
  private tools: LLMToolDef[] = []
  private allTools: any[] = []
  private iterations = 0
  private pendingToolResolvers = new Map<string, (result: unknown) => void>()
  private isRunning = false
  private totalTokensIn = 0
  private totalTokensOut = 0

  constructor(systemPrompt: string, coordinatorName: string) {
    this.coordinatorName = coordinatorName
    this.systemPrompt = buildSystemPrompt(systemPrompt, coordinatorName)
  }

  async startTask(task: CoordinatorTask, tools: LLMToolDef[]): Promise<CoordinatorResult> {
    if (this.isRunning) {
      throw new Error("Worker is already running a task")
    }
    this.isRunning = true
    this.task = task
    this.iterations = 0
    this.messages = []
    this.pendingToolResolvers.clear()
    this.totalTokensIn = 0
    this.totalTokensOut = 0

    // Add spawn_subagent and coordinator-specific decision tool
    const decisionTool = this.coordinatorName === "bee" ? BEE_DECISION_TOOL
      : this.coordinatorName === "architecture" ? ARCHITECTURE_PLAN_TOOL
      : this.coordinatorName === "reviewer" ? REVIEW_VERDICT_TOOL
      : null
    this.tools = [...tools, SPAWN_SUBAGENT_TOOL, ...(decisionTool ? [decisionTool] : [])]
    this.allTools = (task.allTools ?? []) as any[]

    const startTime = performance.now()

    try {
      const provider = task.provider || COORDINATOR_PROVIDER
      const model = task.model || COORDINATOR_MODEL
      const apiKey = resolveApiKey(provider, task.secrets)

      // Build initial messages
      const contextBlock = task.compiledContext
        ? `\n\n${task.compiledContext}`
        : ""

      // Format conversation history for BEE (gives cross-message context within a session)
      const historyBlock = task.conversationHistory?.length
        ? "\n\n## Conversación reciente en esta sesión:\n" +
          task.conversationHistory
            .map(t => `${t.role === "user" ? "Usuario" : "Agente"}: ${t.content}`)
            .join("\n\n")
        : ""

      this.messages = [
        { role: "system", content: this.systemPrompt + contextBlock + historyBlock },
        {
          role: "user",
          content: [
            `## Tarea: ${task.description}`,
            task.adr ? `\n## ADR / Plan de Arquitectura:\n${task.adr}` : "",
            task.narrative ? `\n## Narrativo del Proyecto:\n${task.narrative}` : "",
            task.interfaces ? `\n## Interfaces de Contrato:\n${task.interfaces}` : "",
            task.previousPhaseOutput ? `\n## Output de Fase Anterior:\n${task.previousPhaseOutput}` : "",
            `\n## Modo: ${task.mode}`,
            `\n## Project Path: ${task.projectPath}`,
          ].filter(Boolean).join("\n"),
        },
      ]

      // Agent loop with tool execution
      let finalContent = ""
while (this.iterations < MAX_ITERATIONS) {
        this.iterations++
        // Each iteration gets a unique streamId so thinking chunks from
        // the same LLM call are grouped into one streaming block,
        // while step-start and other metadata are separate blocks.
        const streamId = `step-${this.iterations}`

        // Notify main thread that we're thinking / analyzing (new block, no streamId)
        self.postMessage(JSON.stringify({
          type: "THINKING",
          taskId: this.task!.taskId,
          phaseId: this.task!.phaseId,
          coordinator: this.coordinatorName,
          content: this.iterations === 1
            ? `🧠 ${this.coordinatorName} analizando solicitud...`
            : `🧠 ${this.coordinatorName} razonando (paso ${this.iterations})...`,
        } as WorkerToManagerMessage))

        // Auto-compact context if it's getting too large. Fine-grained pruning
        // (cheaper, lower threshold) runs first; full compaction only kicks in
        // if pruning alone wasn't enough.
        const prunedMessages = pruneOldToolResults(this.messages, model)
        const compactedMessages = compactMessagesIfNeeded(prunedMessages, model)
        if (compactedMessages.length < this.messages.length) {
          self.postMessage(JSON.stringify({
            type: "THINKING",
            taskId: this.task!.taskId,
            phaseId: this.task!.phaseId,
            coordinator: this.coordinatorName,
            content: `📦 Contexto compactado: ${this.messages.length} → ${compactedMessages.length} mensajes`,
          } as WorkerToManagerMessage))
        }
        this.messages = compactedMessages

        // Force a final response as the loop nears its limit — WITHOUT telling the
        // model how many iterations remain. Anthropic/Cognition ("context anxiety")
        // found models given a visible countdown misjudge it and rush/abandon work
        // prematurely; the harness enforces the limit silently, the model never sees it.
        const iterationsLeft = MAX_ITERATIONS - this.iterations
        if (iterationsLeft <= 3) {
          this.messages.push({
            role: "user",
            // The "⚠️ STOPPING" marker is the one the system prompt tells the model to
            // watch for; without it here that instruction referenced a signal that was
            // never actually sent.
            content: `⚠️ STOPPING: produce your FINAL response without any more tool calls. Summarize what you know and respond to the user.`,
          })
        }

        // 2-minute timeout per LLM call to prevent indefinite hangs
        const controller = new AbortController()
        const llmTimeout = setTimeout(() => controller.abort(), 120_000)

        // Stream tokens in real-time so user sees what the agent is thinking
        let streamBuffer = ""
        let lastSentLength = 0

        const onToken = (token: string) => {
          streamBuffer += token
          const unSent = streamBuffer.length - lastSentLength
          if (unSent >= 80 || (unSent > 0 && token.includes("\n"))) {
            const newContent = streamBuffer.slice(lastSentLength)
            lastSentLength = streamBuffer.length
            self.postMessage(JSON.stringify({
              type: "THINKING",
              taskId: this.task!.taskId,
              phaseId: this.task!.phaseId,
              coordinator: this.coordinatorName,
              content: newContent,
              streamId,
            } as WorkerToManagerMessage))
          }
        }

        const response = await callLLM({
          provider,
          model,
          apiKey,
          messages: this.messages,
          tools: this.tools.length > 0 ? this.tools : undefined,
          temperature: 0.3,
          maxTokens: 8192,
          signal: controller.signal,
          onToken,
        })

        clearTimeout(llmTimeout)

        // Accumulate token usage
        this.totalTokensIn  += response.usage?.input_tokens  ?? 0
        this.totalTokensOut += response.usage?.output_tokens ?? 0

// Stream final reasoning text to main thread
        const content = response.content?.trim() || streamBuffer.trim()
        if (content) {
          self.postMessage(JSON.stringify({
            type: "THINKING",
            taskId: this.task!.taskId,
            phaseId: this.task!.phaseId,
            coordinator: this.coordinatorName,
            content: content.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || content,
            streamId,
          } as WorkerToManagerMessage))
        }

        // No tool calls → final response
        if (!response.tool_calls?.length || response.stop_reason !== "tool_calls") {
          // Strip <think>...</think> blocks so narrativeEntry is always clean JSON/text
          const rawContent = response.content?.trim() || "No output generated"
          finalContent = rawContent.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || rawContent
          if (!response.content?.trim()) {
            console.warn(`[worker-handler] ⚠️ ${this.coordinatorName} returned empty content (stop_reason=${response.stop_reason}, tokens_in=${response.usage?.input_tokens}, tokens_out=${response.usage?.output_tokens})`)
          }
          break
        }

        // Add assistant message with tool calls
        this.messages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.tool_calls,
        })

        // Separate local tools (spawn_subagent), decision tools, and remote tools
        const localCalls: LLMToolCall[] = []
        const remoteCalls: LLMToolCall[] = []
        let decisionCall: LLMToolCall | null = null
        for (const tc of response.tool_calls) {
          if (tc.function.name === "spawn_subagent") {
            localCalls.push(tc)
          } else if (DECISION_TOOL_NAMES.includes(tc.function.name)) {
            decisionCall = tc
          } else {
            remoteCalls.push(tc)
          }
        }

        // If the LLM submitted a structured decision, extract it and finish immediately
        if (decisionCall) {
          try {
            const decisionArgs = JSON.parse(decisionCall.function.arguments || "{}")
            finalContent = response.content?.trim() || ""
            return {
              taskId: task.taskId,
              phaseId: task.phaseId,
              coordinator: this.coordinatorName,
              status: "completed",
              narrativeEntry: finalContent,
              filesModified: decisionArgs.filesModified ?? [],
              structuredDecision: decisionArgs,
              durationMs: Math.round(performance.now() - startTime),
              tokensIn: this.totalTokensIn,
              tokensOut: this.totalTokensOut,
            }
          } catch (err) {
            console.warn(`[worker-handler] ⚠️ Failed to parse decision tool arguments: ${(err as Error).message}. Continuing loop.`)
          }
        }

        // Execute local tools (sub-agents) in parallel
        const localResults: Array<{ tool_call_id: string; content: string }> = []
        if (localCalls.length > 0) {
          const localPromises = localCalls.map(async (tc) => {
            const args = JSON.parse(tc.function.arguments || "{}")
            const result = await this.spawnSubAgent(args.agent, args.task)
            return {
              tool_call_id: tc.id,
              content: typeof result === "string" ? result : JSON.stringify(result),
            }
          })
          const results = await Promise.all(localPromises)
          localResults.push(...results)
        }

        // Execute remote tools (via main thread) in parallel
        const remotePromises = remoteCalls.map(async (tc) => {
          const result = await this.executeToolViaMainThread(tc)
          return {
            tool_call_id: tc.id,
            content: typeof result === "string" ? result : JSON.stringify(result),
          }
        })
        const remoteResults = await Promise.all(remotePromises)

        // Dynamic tool injection: when search_knowledge finds tools, add them to loadout
        for (const tc of remoteCalls) {
          if (tc.function.name === "search_knowledge") {
            try {
              const result = JSON.parse(remoteResults.find(r => r.tool_call_id === tc.id)?.content ?? "{}") as any
              const foundTools: Array<{ name: string }> = result?.tools ?? []
              const foundMcpTools: Array<{ tool_name: string; full_name?: string; id?: string }> = result?.toolsmcp ?? []
              const currentToolNames = new Set(this.tools.map(t => t.function?.name))

              for (const found of foundTools) {
                if (!currentToolNames.has(found.name)) {
                  const nativeTool = this.allTools.find((t: any) => t.name === found.name)
                  if (nativeTool) {
                    this.tools.push({
                      type: "function",
                      function: {
                        name: nativeTool.name,
                        description: nativeTool.description ?? "",
                        parameters: nativeTool.parameters ?? { type: "object", properties: {} },
                      },
                    })
                    currentToolNames.add(found.name)
                  }
                }
              }

              for (const found of foundMcpTools) {
                const mcpFullName = found.full_name || found.id
                if (mcpFullName && !currentToolNames.has(mcpFullName)) {
                  const mcpTool = this.allTools.find((t: any) => t.name === mcpFullName)
                  if (mcpTool) {
                    this.tools.push({
                      type: "function",
                      function: {
                        name: mcpTool.name,
                        description: mcpTool.description ?? "",
                        parameters: mcpTool.parameters ?? { type: "object", properties: {} },
                      },
                    })
                    currentToolNames.add(mcpFullName)
                  }
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }

        // Add all tool results to messages
        for (const tr of [...localResults, ...remoteResults]) {
          this.messages.push({
            role: "tool",
            content: tr.content,
            tool_call_id: tr.tool_call_id,
          })
        }
      }

      const durationMs = Math.round(performance.now() - startTime)

      if (this.iterations >= MAX_ITERATIONS) {
        return {
          taskId: task.taskId,
          phaseId: task.phaseId,
          coordinator: this.coordinatorName,
          status: "failed",
          narrativeEntry: finalContent || `Worker ${this.coordinatorName} exhausted ${MAX_ITERATIONS} iterations without completing the task.`,
          filesModified: [],
          blockerDescription: `Reached iteration limit (${MAX_ITERATIONS}). ForensicAgent will analyze.`,
          iterationLimitReached: true,
          durationMs,
          tokensIn: this.totalTokensIn,
          tokensOut: this.totalTokensOut,
        }
      }

      return {
        taskId: task.taskId,
        phaseId: task.phaseId,
        coordinator: this.coordinatorName,
        status: "completed",
        narrativeEntry: finalContent,
        filesModified: [],
        durationMs,
        tokensIn: this.totalTokensIn,
        tokensOut: this.totalTokensOut,
      }
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime)
      const errorMsg = (err as Error).message

      return {
        taskId: task.taskId,
        phaseId: task.phaseId,
        coordinator: this.coordinatorName,
        status: "failed",
        narrativeEntry: `## ${this.coordinatorName} — Error\n\n\`\`\`\n${errorMsg}\n\`\`\``,
        filesModified: [],
        blockerDescription: errorMsg,
        durationMs,
      }
    } finally {
      this.isRunning = false
    }
  }

  /** Spawn a sub-agent worker and execute a task */
  private async spawnSubAgent(name: string, taskContext: string): Promise<string> {
    if (!isValidSubAgent(this.coordinatorName, name)) {
      return JSON.stringify({ ok: false, error: `Sub-agent '${name}' is not valid for ${this.coordinatorName} coordinator` })
    }

    const subAgent = getSubAgent(name)
    if (!subAgent) {
      return JSON.stringify({ ok: false, error: `Sub-agent '${name}' not found in registry` })
    }

    return new Promise((resolve) => {
      let resolved = false
      const worker = new (Worker as any)(SUBAGENT_WORKER_PATH, { smol: true }) as Bun.Worker

      worker.onmessage = (msg: MessageEvent) => {
        if (resolved) return
        resolved = true
        const data = msg.data as { type: string; result?: string; error?: string; durationMs?: number }

        if (data.type === "SUBAGENT_RESULT") {
          if (data.error) {
            resolve(JSON.stringify({ ok: false, error: data.error, durationMs: data.durationMs }))
          } else {
            resolve(JSON.stringify({ ok: true, result: data.result, durationMs: data.durationMs }))
          }
        }

        worker.terminate()
      }

      worker.onerror = (err: ErrorEvent) => {
        if (resolved) return
        resolved = true
        resolve(JSON.stringify({ ok: false, error: `Sub-agent worker error: ${err.message}` }))
        worker.terminate()
      }

      // Send task to sub-agent
      worker.postMessage(JSON.stringify({
        type: "SUBAGENT_TASK",
        systemPrompt: subAgent.systemPrompt,
        task: taskContext,
        secrets: this.task?.secrets,
        provider: this.task?.provider || COORDINATOR_PROVIDER,
        model: this.task?.model || COORDINATOR_MODEL,
        temperature: subAgent.temperature,
        maxTokens: subAgent.maxTokens,
      }))

      // Timeout after 3 minutes
      setTimeout(() => {
        if (resolved) return
        resolved = true
        resolve(JSON.stringify({ ok: false, error: "Sub-agent timed out after 3 minutes" }))
        worker.terminate()
      }, 180_000)
    })
  }

  /** Request tool execution from the main thread and wait for result */
  private executeToolViaMainThread(tc: LLMToolCall): Promise<unknown> {
    return new Promise((resolve) => {
      const toolCallId = tc.id
      this.pendingToolResolvers.set(toolCallId, resolve)

      // Send TOOL_CALL to main thread via string fast-path
      self.postMessage(JSON.stringify({
        type: "TOOL_CALL",
        taskId: this.task!.taskId,
        phaseId: this.task!.phaseId,
        coordinator: this.coordinatorName,
        toolName: tc.function.name,
        toolArgs: JSON.parse(tc.function.arguments || "{}"),
        toolCallId,
      } as WorkerToManagerMessage))

      // Timeout after 60 seconds
      setTimeout(() => {
        if (this.pendingToolResolvers.has(toolCallId)) {
          this.pendingToolResolvers.delete(toolCallId)
          resolve({ ok: false, error: "Tool execution timed out after 60s" })
        }
      }, 60_000)
    })
  }

  /** Handle TOOL_RESULT from main thread */
  handleToolResult(toolCallId: string, result: unknown): void {
    const resolver = this.pendingToolResolvers.get(toolCallId)
    if (resolver) {
      this.pendingToolResolvers.delete(toolCallId)
      resolver(result)
    }
  }
}

/** Create and manage a worker handler */
export function createWorkerHandler(systemPrompt: string, coordinatorName: string): void {
  const agent = new WorkerAgent(systemPrompt, coordinatorName)
  let currentTask: CoordinatorTask | null = null

  self.onmessage = async (event) => {
    const rawData = event.data as string | ManagerToWorkerMessage
    const msg = typeof rawData === "string" ? JSON.parse(rawData) as ManagerToWorkerMessage : rawData

    if (msg.type === "TASK" && msg.task) {
      currentTask = msg.task
      // Tools are passed in the task or we use an empty list
      // The actual tool list is configured by the manager
      const tools: LLMToolDef[] = (msg.task as any).tools || []
      const result = await agent.startTask(msg.task, tools)

      // Send via string fast-path (SPEC §3.1: ~500 ns latency)
      self.postMessage(JSON.stringify({
        type: "RESULT",
        taskId: result.taskId,
        phaseId: result.phaseId,
        coordinator: coordinatorName,
        result,
      }))
      return
    }

    if (msg.type === "TOOL_RESULT" && msg.toolCallId) {
      agent.handleToolResult(msg.toolCallId, msg.result)
      return
    }
  }
}
