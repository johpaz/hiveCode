/**
 * Compaction — Fase 6.
 *
 * Compresses conversation history when token count exceeds threshold.
 * Uses the active LLM to summarize old messages, preserving:
 *   - User data and preferences
 *   - Decisions made
 *   - Tool results
 *   - Context needed to continue
 *
 * Saves summary to `summaries` table. Original messages are kept (audit trail)
 * but the Context Compiler uses the summary instead of old messages.
 *
 * Also implements "tool result clearing": replaces old tool results with
 * short summaries in the in-memory message array before model calls.
 */

import { logger } from "../utils/logger"
import {
  getTotalTokens,
  getHistory,
  getSummary,
  saveSummary,
  toAPIMessages,
  getMessageCount,
} from "./conversation-store"
import { estimateTokens } from "../utils/toon"
import { callLLM, resolveProviderConfig, type ContentPart } from "./llm-client"
import { col, fromIndexable } from "../storage/hive"
import type { AgentDoc, CodeConfigDoc } from "../storage/collections"

const log = logger.child("compaction")

// Token budget: compress when stored tokens exceed this threshold
const COMPACT_TOKEN_THRESHOLD = 6000   // ~60% of 10K context window
const KEEP_LAST_N_MESSAGES = 5         // always keep most recent N messages
const TOOL_RESULT_MAX_CHARS = 600      // max chars for old tool results after clearing
const MAX_TRANSCRIPT_MSGS = 30         // cap messages sent to summarizer (avoids OOM on small models)
const MAX_MSG_CHARS = 300              // chars per message in transcript

/**
 * Check if compaction is needed and run it if so.
 * Called at the start of each agent loop iteration.
 */
export async function maybeCompact(
  threadId: string,
  notify?: { channel: string; userId: string }
): Promise<void> {
  try {
    const totalTokens = await getTotalTokens(threadId)
    if (totalTokens < COMPACT_TOKEN_THRESHOLD) return

    const summary = await getSummary(threadId)
    const totalMessages = await getMessageCount(threadId)

    // Already summarized up to near the current state
    if (summary && summary.last_message_id > totalMessages - KEEP_LAST_N_MESSAGES) return

    log.info(`[compaction] Compacting thread=${threadId} tokens=${totalTokens}`)
    await compactThread(threadId, notify)
  } catch (err) {
    log.warn("[compaction] Error during compaction check:", err)
  }
}

/**
 * Compress a thread's history into a summary.
 */
export async function compactThread(
  threadId: string,
  notify?: { channel: string; userId: string }
): Promise<void> {
  const allMessages = await getHistory(threadId)
  if (allMessages.length <= KEEP_LAST_N_MESSAGES) return

  // Find a clean cut point: the "keep" side must begin with a user turn so
  // we never leave orphaned tool messages at the start of the visible window.
  let cutIndex = allMessages.length - KEEP_LAST_N_MESSAGES
  while (cutIndex > 0 && allMessages[cutIndex]?.role !== "user") {
    cutIndex--
  }
  if (cutIndex <= 0) {
    log.info(`[compaction] No clean user-turn boundary found — skipping`)
    return
  }

  const toSummarize = allMessages.slice(0, cutIndex)
  if (toSummarize.length === 0) return

  const lastSummarizedId = toSummarize[toSummarize.length - 1].id

  const existingSummary = await getSummary(threadId)
  if (existingSummary && existingSummary.last_message_id >= lastSummarizedId) return

  // Cap transcript to avoid overflowing small model contexts
  const capped = toSummarize.slice(-MAX_TRANSCRIPT_MSGS)
  const apiMessages = toAPIMessages(capped)
  const transcript = apiMessages
    .map((m) => {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter(p => p.type === "text").map(p => (p as any).text).join("\n")
          : ""
      return `[${m.role.toUpperCase()}]: ${text.substring(0, MAX_MSG_CHARS)}`
    })
    .join("\n\n")

  const agents = await col<AgentDoc>("agents")
  const coordinator = (await agents.findBy("role", "coordinator"))[0]?.doc

  let provId = fromIndexable(coordinator?.provider_id)
  let modId = fromIndexable(coordinator?.model_id)
  if (!provId || !modId) {
    const codeConfig = await col<CodeConfigDoc>("codeConfig")
    const cfgRow = await codeConfig.get("default_provider")
    const fallbackProvider = cfgRow?.doc.value || "gemini"
    const modelKey = `provider_model_${fallbackProvider}`
    const modelRow = await codeConfig.get(modelKey)
    provId = provId || fallbackProvider
    modId = modId || modelRow?.doc.value || "gemini-2.5-flash"
  }
  const providerCfg = await resolveProviderConfig(provId, modId)

  const summaryResponse = await callLLM({
    ...providerCfg,
    messages: [
      {
        role: "system",
        content:
          "You are a conversation summarizer. Create a concise summary preserving: " +
          "user preferences, decisions made, important facts, tool results, and context needed to continue.",
      },
      {
        role: "user",
        content: `Summarize this conversation (${toSummarize.length} messages) in 3-5 sentences:\n\n${transcript}`,
      },
    ],
  })

  const summary = summaryResponse.content.trim()
  if (!summary) return

  await saveSummary(threadId, summary, toSummarize.length, lastSummarizedId)
  log.info(
    `[compaction] Thread ${threadId} compacted: ${toSummarize.length} msgs → ${estimateTokens(summary)} tokens`
  )

  // Notify user in their active channel (non-critical)
  if (notify?.channel && notify?.userId) {
    try {
      const { sendToUserChannel } = await import("../gateway/channel-notify")
      await sendToUserChannel(
        notify.channel,
        notify.userId,
        `🗜️ Resumí ${toSummarize.length} mensajes anteriores para mantener el contexto limpio.`
      )
    } catch {
      // Non-critical — don't break the flow if notification fails
    }
  }
}

/**
 * Clear old tool results in-memory to reduce tokens before a model call.
 * Does NOT modify the database — only the in-memory messages array.
 *
 * Strategy: COMPRESS (Context Engineering)
 * - Replaces old tool results with short summaries
 * - Keeps the most recent `keepLastTurns` turns intact
 * - Never truncates the latest result of any given tool
 *
 * The window is measured in **turns** (assistant messages), not raw messages. Counting
 * raw messages meant that a turn with several parallel tool calls consumed the whole
 * budget on its own, so the model lost sight of what it had just done after ~2 turns
 * and started repeating tool calls.
 */
export function clearOldToolResults<T extends { role: string; content: string | ContentPart[]; tool_call_id?: string }>(
  messages: T[],
  keepLastTurns = 4
): T[] {
  const cutoffIndex = findTurnCutoff(messages, keepLastTurns)
  if (cutoffIndex <= 0) return messages

  // The freshest result of each tool stays intact even when it falls outside the window:
  // it is the model's only record that the call already happened.
  const freshestByTool = new Map<string, number>()
  for (let i = 0; i < cutoffIndex; i++) {
    const msg = messages[i]
    if (msg.role !== "tool") continue
    freshestByTool.set(toolNameForResult(messages, i), i)
  }
  const protectedIndexes = new Set(freshestByTool.values())

  return messages.map((msg, i) => {
    if (i >= cutoffIndex || protectedIndexes.has(i)) return msg
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg
    if (msg.content.length <= TOOL_RESULT_MAX_CHARS) return msg

    const head = msg.content.substring(0, TOOL_RESULT_MAX_CHARS)
    const looksStructured = msg.content.trim().startsWith("{") || msg.content.trim().includes(":")
    return {
      ...msg,
      content: looksStructured
        ? `[Tool result summarized: ${head}...]`
        : `[Result truncated: ${head}...]`,
    }
  })
}

/** Index of the first message belonging to the last `keepLastTurns` assistant turns. */
function findTurnCutoff(messages: Array<{ role: string }>, keepLastTurns: number): number {
  let turns = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue
    turns++
    if (turns >= keepLastTurns) return i
  }
  return 0
}

/**
 * Best-effort tool name for a result, resolved through the assistant turn that
 * requested it. Falls back to the call id so distinct calls never collapse.
 */
function toolNameForResult(
  messages: Array<{ role: string; tool_call_id?: string; tool_calls?: any[] }>,
  index: number,
): string {
  const callId = messages[index].tool_call_id
  if (callId) {
    for (let i = index - 1; i >= 0; i--) {
      const call = messages[i].tool_calls?.find((tc: any) => tc.id === callId)
      if (call?.function?.name) return call.function.name
    }
    return callId
  }
  return `#${index}`
}

/**
 * Summarize a tool result to a single line
 * Used for very old tool results (> 10 turns)
 */
export function summarizeToolResult(content: string, toolName?: string): string {
  // Try to extract success/failure status
  const isError = content.includes('error') || content.includes('failed') || content.startsWith('[Tool Error]')
  const isSuccess = content.includes('ok') || content.includes('success') || content.includes('true')
  
  // Try to extract key result field from JSON/TOON
  let keyInfo = ""
  try {
    // Simple extraction of first key value
    const firstLine = content.split('\n')[0].substring(0, 80)
    keyInfo = firstLine
  } catch {
    keyInfo = content.substring(0, 80)
  }
  
  const status = isError ? "failed" : isSuccess ? "success" : "completed"
  return `[${toolName || 'Tool'} ${status}: ${keyInfo}...]`
}
