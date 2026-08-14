/**
 * Conversation Store — persists message history in HiveDB.
 *
 * Also manages summaries and scratchpad notes. New installs start directly on
 * these document collections; there is no legacy database compatibility path.
 */

import { bumpRollup, col, nextId } from "../storage/hive"
import type { ConversationDoc, ScratchpadDoc, SummaryDoc } from "../storage/collections"
import { logger } from "../utils/logger"
import type { ContentPart, LLMMessage } from "./llm-client"
import { estimateTokens } from "../utils/toon"

const log = logger.child("conv-store")

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredMessage {
  /** Per-thread monotonic sequence number. Scope comparisons to thread_id. */
  id: number
  thread_id: string
  channel: string
  role: "user" | "assistant" | "tool" | "system"
  content: string
  tool_calls_json: string | null
  tool_call_id: string | null
  reasoning_content: string | null
  content_multimodal: string | null
  token_count: number
  created_at: number
}

export interface Summary {
  summary: string
  last_message_id: number
  messages_covered: number
}

export interface ScratchpadNoteRow {
  id: string
  thread_id: string
  key: string
  value: string
  source: string | null
  created_at: number
  updated_at: number
}

function storageId(threadId: string, seq: number): string {
  return `${threadId}:${String(seq).padStart(15, "0")}`
}

function scratchpadId(threadId: string, key: string): string {
  return `${threadId}:${key}`
}

function toStoredMessage(id: string, doc: ConversationDoc): StoredMessage {
  const seq = parseInt(id.slice(id.lastIndexOf(":") + 1), 10)
  return {
    id: Number.isFinite(seq) ? seq : 0,
    thread_id: doc.thread_id,
    channel: doc.channel,
    role: doc.role,
    content: doc.content,
    tool_calls_json: doc.tool_calls_json,
    tool_call_id: doc.tool_call_id,
    reasoning_content: doc.reasoning_content,
    content_multimodal: doc.content_multimodal,
    token_count: doc.token_count,
    created_at: doc.created_at,
  }
}

// ─── Message operations ───────────────────────────────────────────────────────

export async function addMessage(
  threadId: string,
  role: StoredMessage["role"],
  content: string | ContentPart[],
  opts?: {
    channel?: string
    tool_calls?: LLMMessage["tool_calls"]
    tool_call_id?: string
    reasoning_content?: string
  }
): Promise<number> {
  const textContent = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter(p => p.type === "text").map(p => (p as any).text).join("\n")
      : String(content)

  const contentMultimodal = Array.isArray(content) ? JSON.stringify(content) : null
  const toolCallsJson = opts?.tool_calls ? JSON.stringify(opts.tool_calls) : null
  const paddedSeq = await nextId(`conversations:${threadId}`)
  const seq = parseInt(paddedSeq, 10)
  const now = Date.now()
  const id = storageId(threadId, seq)

  const conversations = await col<ConversationDoc>("conversations")
  await conversations.put(id, {
    id,
    thread_id: threadId,
    channel: opts?.channel ?? "webchat",
    role,
    content: textContent,
    content_multimodal: contentMultimodal,
    tool_calls_json: toolCallsJson,
    tool_call_id: opts?.tool_call_id ?? null,
    reasoning_content: opts?.reasoning_content ?? null,
    token_count: Math.max(1, estimateTokens(textContent) + estimateTokens(toolCallsJson ?? "")),
    created_at: now,
    updated_at: now,
  }, { expectedVersion: 0 })

  const hour = new Date(now).toISOString().slice(0, 13)
  bumpRollup("activityRollups", hour, { messageCount: 1 }).catch(() => {})

  return seq
}

export async function getHistory(threadId: string, limit = 200): Promise<StoredMessage[]> {
  const conversations = await col<ConversationDoc>("conversations")
  const entries = await conversations.scan({ prefix: `${threadId}:`, limit })
  return entries.map((entry) => toStoredMessage(entry.id, entry.doc))
}

export async function getRecentMessages(threadId: string, n: number): Promise<StoredMessage[]> {
  const conversations = await col<ConversationDoc>("conversations")
  const entries = await conversations.scan({ prefix: `${threadId}:`, reverse: true, limit: n })
  const rows = entries.map((entry) => toStoredMessage(entry.id, entry.doc)).reverse()
  return stripLeadingOrphanedTools(rows)
}

function stripLeadingOrphanedTools(rows: StoredMessage[]): StoredMessage[] {
  const knownIds = new Set<string>()
  for (const row of rows) {
    if (row.role === "assistant" && row.tool_calls_json) {
      try {
        const toolCalls = JSON.parse(row.tool_calls_json) as Array<{ id: string }>
        for (const toolCall of toolCalls) knownIds.add(toolCall.id)
      } catch {
        // Ignore malformed historical tool JSON.
      }
    }
  }

  let start = 0
  while (
    start < rows.length &&
    rows[start].role === "tool" &&
    rows[start].tool_call_id !== null &&
    !knownIds.has(rows[start].tool_call_id!)
  ) {
    start++
  }

  if (start > 0) {
    log.warn(`[conv-store] Stripped ${start} leading orphaned tool message(s) from window`)
  }
  return start > 0 ? rows.slice(start) : rows
}

export async function getMessageCount(threadId: string): Promise<number> {
  const conversations = await col<ConversationDoc>("conversations")
  return (await conversations.scan({ prefix: `${threadId}:` })).length
}

export async function getTotalTokens(threadId: string): Promise<number> {
  const conversations = await col<ConversationDoc>("conversations")
  const entries = await conversations.scan({ prefix: `${threadId}:` })
  return entries.reduce((sum, entry) => sum + entry.doc.token_count, 0)
}

export async function getMessagesAfter(threadId: string, afterId: number): Promise<StoredMessage[]> {
  const conversations = await col<ConversationDoc>("conversations")
  const entries = await conversations.scan({ prefix: `${threadId}:` })
  return entries
    .map((entry) => toStoredMessage(entry.id, entry.doc))
    .filter((message) => message.id > afterId)
}

// ─── Convert stored messages → LLMMessage array ───────────────────────────────

export function toAPIMessages(rows: StoredMessage[]): LLMMessage[] {
  return rows.map((row) => {
    let content: string | ContentPart[] = row.content
    if (row.content_multimodal) {
      try { content = JSON.parse(row.content_multimodal) } catch { /* ignore */ }
    }
    const message: LLMMessage = { role: row.role, content }
    if (row.tool_calls_json) {
      try { message.tool_calls = JSON.parse(row.tool_calls_json) } catch { /* ignore */ }
    }
    if (row.tool_call_id) message.tool_call_id = row.tool_call_id
    if (row.reasoning_content) message.reasoning_content = row.reasoning_content
    return message
  })
}

// ─── Summaries ────────────────────────────────────────────────────────────────

export async function getSummary(threadId: string): Promise<Summary | null> {
  const summaries = await col<SummaryDoc>("summaries")
  const entry = await summaries.get(threadId)
  if (!entry) return null
  return {
    summary: entry.doc.summary,
    last_message_id: entry.doc.last_message_id ? parseInt(entry.doc.last_message_id, 10) : 0,
    messages_covered: entry.doc.messages_covered,
  }
}

export async function saveSummary(
  threadId: string,
  summary: string,
  messagesCovered: number,
  lastMessageId: number
): Promise<void> {
  const summaries = await col<SummaryDoc>("summaries")
  const existing = await summaries.get(threadId)
  const now = Date.now()
  await summaries.put(threadId, {
    thread_id: threadId,
    summary,
    messages_covered: messagesCovered,
    last_message_id: String(lastMessageId),
    created_at: existing?.doc.created_at ?? now,
    updated_at: now,
  }, { expectedVersion: existing?.version ?? 0 })
}

// ─── Scratchpad ───────────────────────────────────────────────────────────────

export async function saveScratchpadNote(
  threadId: string,
  key: string,
  value: string,
  source?: string
): Promise<void> {
  const scratchpad = await col<ScratchpadDoc>("scratchpad")
  const id = scratchpadId(threadId, key)
  const existing = await scratchpad.get(id)
  const now = Date.now()
  await scratchpad.put(id, {
    id,
    thread_id: threadId,
    key,
    value,
    source: source ?? null,
    created_at: existing?.doc.created_at ?? now,
    updated_at: now,
  }, { expectedVersion: existing?.version ?? 0 })
}

export async function getScratchpad(threadId: string): Promise<Array<{ key: string; value: string }>> {
  const scratchpad = await col<ScratchpadDoc>("scratchpad")
  const entries = await scratchpad.scan({ prefix: `${threadId}:` })
  return entries
    .sort((a, b) => b.doc.updated_at - a.doc.updated_at)
    .map((entry) => ({ key: entry.doc.key, value: entry.doc.value }))
}

export async function listAllScratchpadNotes(limit: number): Promise<ScratchpadNoteRow[]> {
  const scratchpad = await col<ScratchpadDoc>("scratchpad")
  const entries = await scratchpad.scan({})
  return entries
    .sort((a, b) => b.doc.updated_at - a.doc.updated_at)
    .slice(0, limit)
    .map((entry) => ({
      id: entry.id,
      thread_id: entry.doc.thread_id,
      key: entry.doc.key,
      value: entry.doc.value,
      source: entry.doc.source,
      created_at: entry.doc.created_at,
      updated_at: entry.doc.updated_at,
    }))
}

export async function deleteScratchpadNote(threadId: string, key: string): Promise<void> {
  const scratchpad = await col<ScratchpadDoc>("scratchpad")
  await scratchpad.delete(scratchpadId(threadId, key))
}
