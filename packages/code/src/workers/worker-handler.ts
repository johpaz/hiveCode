import { callLLM } from "@johpaz/hive-code-core/agent/llm-client"
import type { LLMMessage, LLMToolDef, LLMToolCall } from "@johpaz/hive-code-core/agent/llm-client"
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
const MAX_ITERATIONS = 10

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
  return agents.map(a => `  - ${a.name}: ${a.description}`).join("\n")
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

    // Add spawn_subagent to available tools
    this.tools = [...tools, SPAWN_SUBAGENT_TOOL]

    const startTime = performance.now()

    try {
      const provider = COORDINATOR_PROVIDER
      const model = COORDINATOR_MODEL
      const apiKey = resolveApiKey(provider, task.secrets)

      // Build initial messages
      this.messages = [
        { role: "system", content: this.systemPrompt },
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

        const response = await callLLM({
          provider,
          model,
          apiKey,
          messages: this.messages,
          tools: this.tools.length > 0 ? this.tools : undefined,
          temperature: 0.3,
          maxTokens: 8192,
        })

        // No tool calls → final response
        if (!response.tool_calls?.length || response.stop_reason !== "tool_calls") {
          finalContent = response.content?.trim() || "No output generated"
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

        // Execute remote tools (via main thread)
        const remoteResults: Array<{ tool_call_id: string; content: string }> = []
        for (const tc of remoteCalls) {
          const result = await this.executeToolViaMainThread(tc)
          remoteResults.push({
            tool_call_id: tc.id,
            content: typeof result === "string" ? result : JSON.stringify(result),
          })
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
          status: "completed",
          narrativeEntry: finalContent + "\n\n_(Reached max iterations)_",
          filesModified: [],
          durationMs,
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
      worker.postMessage({
        type: "SUBAGENT_TASK",
        systemPrompt: subAgent.systemPrompt,
        task: taskContext,
        secrets: this.task?.secrets,
        provider: COORDINATOR_PROVIDER,
        model: COORDINATOR_MODEL,
        temperature: subAgent.temperature,
        maxTokens: subAgent.maxTokens,
      })

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
