// ─── Streaming text extractor for BEE's JSON output ──────────────────────────
// BEE outputs JSON like {"action":"...", "reason":"...", "content":"..."}.
// During streaming, we progressively extract readable text from partial JSON
// so the user sees the reasoning in real-time, not raw JSON syntax.

class StreamingJsonTextExtractor {
  private buffer = ""
  private lastEmittedIdx = 0

  /** Add a token and get any new readable text to display */
  addToken(token: string): string | null {
    this.buffer += token

    // Don't try to parse too often — wait until we have enough content
    if (this.buffer.length < 40 && this.buffer.length - this.lastEmittedIdx < 30) {
      return null
    }

    const readable = this.extractReadableText()
    if (readable === null) return null

    // Only emit new text since last emission
    if (readable.length > this.lastEmittedIdx) {
      const newText = readable.slice(this.lastEmittedIdx)
      this.lastEmittedIdx = readable.length
      return newText
    }
    return null
  }

  /** Extract readable text from accumulated buffer */
  private extractReadableText(): string | null {
    const trimmed = this.buffer.trimStart()

    // If it doesn't look like JSON, it's plain narrative text — stream as-is
    if (!trimmed.startsWith("{") && !trimmed.startsWith("```")) {
      return this.buffer
    }

    // Try to extract text from known JSON fields: reason, content, thought, thinking
    // These regex patterns match both complete strings and strings still being streamed
    const textFields = ["reason", "content", "thought", "thinking", "response", "message"]
    let bestMatch = ""
    let bestIdx = -1

    for (const field of textFields) {
      // Match "field": "value" — handles escaped quotes and partial strings
      const regex = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "s")
      const match = this.buffer.match(regex)
      if (match && match.index !== undefined) {
        // Decode common JSON escape sequences
        const decoded = match[1]
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
        if (decoded.length > bestMatch.length) {
          bestMatch = decoded
          bestIdx = match.index
        }
      }
    }

    if (bestMatch) return bestMatch

    // No text field found yet — might still be streaming the JSON structure
    // If we see a clear JSON structure with just the action field, show a status
    const actionMatch = this.buffer.match(/"action"\s*:\s*"([^"]+)"/)
    if (actionMatch) {
      return `Decidiendo: ${actionMatch[1]}...`
    }

    return null
  }

  /** Get the full readable text extracted so far */
  getFullText(): string {
    const readable = this.extractReadableText()
    return readable || this.buffer
  }

  reset(): void {
    this.buffer = ""
    this.lastEmittedIdx = 0
  }
}

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

/** Resolve API key using getEnvironmentData → task.secrets → env fallback */
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

class WorkerAgent {
  private coordinatorName: string
  private systemPrompt: string
  private task: CoordinatorTask | null = null
  private messages: LLMMessage[] = []
  private tools: LLMToolDef[] = []
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

    // Add spawn_subagent to available tools
    this.tools = [...tools, SPAWN_SUBAGENT_TOOL]

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

        // Auto-compact context if it's getting too large
        const compactedMessages = compactMessagesIfNeeded(this.messages, model)
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

        // Inject stopping signal when approaching limit
        // This forces the LLM to produce a final response instead of more tool calls
        const iterationsLeft = MAX_ITERATIONS - this.iterations
        if (iterationsLeft <= 3) {
          this.messages.push({
            role: "user",
            content: `⚠️ STOPPING: You have ${iterationsLeft} iteration(s) left. You MUST produce your FINAL response now without any more tool calls. Summarize what you know and respond to the user.`,
          })
        }

        // 2-minute timeout per LLM call to prevent indefinite hangs
        const controller = new AbortController()
        const llmTimeout = setTimeout(() => controller.abort(), 120_000)

        // Stream tokens in real-time so user sees what the agent is thinking
        // For BEE: use StreamingJsonTextExtractor to show readable text, not raw JSON
        // For other coordinators: stream tokens directly as they arrive
        let streamBuffer = ""
        let lastSentLength = 0
        const isBee = this.coordinatorName === "bee"
        const jsonExtractor = isBee ? new StreamingJsonTextExtractor() : null

        const onToken = (token: string) => {
          streamBuffer += token

          if (isBee && jsonExtractor) {
            // BEE: extract readable text from partial JSON and send incrementally
            const newText = jsonExtractor.addToken(token)
            if (newText) {
              self.postMessage(JSON.stringify({
                type: "THINKING",
                taskId: this.task!.taskId,
                phaseId: this.task!.phaseId,
                coordinator: this.coordinatorName,
                content: newText,
                streamId,
              } as WorkerToManagerMessage))
            }
          } else {
            // Other coordinators: send new text added since last emission
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

// Stream reasoning text to main thread so the user sees what the agent is thinking
        const content = response.content?.trim() || streamBuffer.trim()
        if (content) {
          let displayText = content
          // For BEE, extract the "reason" field from its JSON routing output for final display
          if (isBee) {
            try {
              const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/(\{[\s\S]*\})/)
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0])
                if (parsed.reason) displayText = String(parsed.reason)
                else if (parsed.content) displayText = String(parsed.content)
              }
            } catch {
              // Not JSON, use extractor result or raw content
              const extracted = jsonExtractor?.getFullText()
              if (extracted && extracted.length > 10) displayText = extracted
            }
          }
          if (displayText) {
            self.postMessage(JSON.stringify({
              type: "THINKING",
              taskId: this.task!.taskId,
              phaseId: this.task!.phaseId,
              coordinator: this.coordinatorName,
              content: displayText,
              streamId,
            } as WorkerToManagerMessage))
          }
        }

        // No tool calls → final response
        if (!response.tool_calls?.length || response.stop_reason !== "tool_calls") {
          finalContent = response.content?.trim() || "No output generated"
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

        // Separate local tools (spawn_subagent) from remote tools
        const localCalls: LLMToolCall[] = []
        const remoteCalls: LLMToolCall[] = []
        for (const tc of response.tool_calls) {
          if (tc.function.name === "spawn_subagent") {
            localCalls.push(tc)
          } else {
            remoteCalls.push(tc)
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
