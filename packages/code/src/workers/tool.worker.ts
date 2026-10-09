import { runWithTaskSignal } from "@johpaz/hivecode-core/runtime/task-execution"
/**
 * Tool Worker — dedicated worker for executing tools in parallel.
 *
 * Receives: { type: "TOOL_TASK", toolName, toolArgs, config }
 * Sends: { type: "TOOL_RESULT", toolCallId, result, error? }
 */

import { createAllTools } from "@johpaz/hivecode-core/tools"
import { loadConfig } from "@johpaz/hivecode-core/config"
import type { Tool } from "@johpaz/hivecode-core/tools"

let tools: Tool[] | null = null
const running = new Map<string, AbortController>()

async function getTools() {
  if (!tools) {
    const config = await loadConfig()
    tools = createAllTools(config)
  }
  return tools
}

declare var self: {
  onmessage: ((event: { data: { type: string; toolName: string; toolArgs: any; toolCallId: string; config: any } }) => void) | null
  postMessage(message: any): void
}

self.onmessage = async (event) => {
  const { type, toolName, toolArgs, toolCallId, config } = event.data

  if (type === "CANCEL_TOOL") { running.get(toolCallId)?.abort(new Error("Task cancelled")); return }
  if (type !== "TOOL_TASK") return
  const controller = new AbortController()
  running.set(toolCallId, controller)

  try {
    const allTools = await getTools()
    const tool = allTools.find(t => t.name === toolName)

    if (!tool || !tool.execute) {
      self.postMessage({
        type: "TOOL_RESULT",
        toolCallId,
        error: `Tool '${toolName}' not found or not executable in worker`,
      })
      return
    }

    const result = await runWithTaskSignal(controller.signal, () => tool.execute(toolArgs, { ...config, signal: controller.signal }))

    self.postMessage({
      type: "TOOL_RESULT",
      toolCallId,
      result,
    })
  } catch (err) {
    self.postMessage({
      type: "TOOL_RESULT",
      toolCallId,
      error: (err as Error).message,
    })
  } finally { running.delete(toolCallId) }
}
