/**
 * Context budget — keeps every model call inside the window the model really has.
 *
 * Three things used to be unbounded: one tool result (an `fs_list` of a whole
 * repo), the history compiled for a turn, and the messages a tool loop piles up
 * within a run. A server with a ~50k window answered the third with
 * `400 … exceeds the available context size` and the run died.
 */

import type { LLMMessage } from "./llm-client"

/** Window assumed when the model record has none. */
export const DEFAULT_CONTEXT_WINDOW = 32_768

/** Share of the window a request may fill; the rest is the answer and estimation error. */
export const COMPACT_RATIO = 0.8

/**
 * Characters per token. `estimateTokens` uses 4, which is generous for code and
 * JSON (≈3) — and an underestimate is exactly what turns a budget into a 400.
 */
const CHARS_PER_TOKEN = 3.5

export const contentText = (content: LLMMessage["content"]): string =>
  typeof content === "string" ? content : JSON.stringify(content)

export const budgetTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

export const messageTokens = (m: LLMMessage): number => budgetTokens(contentText(m.content)) + 4

export function resolveWindow(contextWindow?: number): number {
  return contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW
}

// ── One tool result ───────────────────────────────────────────────────────────

/** Most characters one tool result may put into the context: ~8 % of the window, 4k–16k. */
export function toolResultCap(contextWindow?: number): number {
  const window = resolveWindow(contextWindow)
  return Math.min(16_000, Math.max(4_000, Math.floor(window * 0.08 * CHARS_PER_TOKEN)))
}

/**
 * Cut the middle out of an oversized text, keeping its start and its end — the
 * start says what it is, the end is where errors and totals live.
 */
export function clipMiddle(text: string, maxChars: number, hint: string): string {
  if (text.length <= maxChars) return text
  const marker = `\n[… recortado: ${text.length} caracteres, se muestran ${maxChars}. ${hint} …]\n`
  const keep = Math.max(200, maxChars - marker.length)
  const head = Math.ceil(keep * 0.7)
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (keep - head))}`
}

export function capToolResult(text: string, contextWindow?: number): string {
  return clipMiddle(
    text,
    toolResultCap(contextWindow),
    "Pide menos: usa un rango (fs_read offset/limit), una ruta más específica o search_knowledge",
  )
}

// ── History compiled for a turn ───────────────────────────────────────────────

/**
 * Drops the oldest history until it fits `budget` tokens. The last `minKeep`
 * messages — the current turn and the exchange it refers to — always stay, even
 * over budget: a window too small for them is better served by a truncated
 * prompt than by an answer with no conversation at all. A single oversized
 * newest message is trimmed from the middle.
 *
 * (Ported from hive's context compiler.)
 */
export function fitMessagesToBudget(messages: LLMMessage[], budget: number, minKeep = 4): LLMMessage[] {
  let total = messages.reduce((sum, m) => sum + messageTokens(m), 0)
  if (total <= budget || messages.length === 0) return messages
  const kept = [...messages]
  while (kept.length > Math.max(1, minKeep) && total > budget) total -= messageTokens(kept.shift()!)
  // History must open on a user turn: providers reject or drop a leading model turn.
  while (kept.length > 1 && kept[0].role !== "user") total -= messageTokens(kept.shift()!)
  const last = kept[kept.length - 1]
  if (total > budget && typeof last.content === "string") {
    const maxChars = Math.max(400, Math.floor(Math.max(budget, 100) * CHARS_PER_TOKEN))
    if (last.content.length > maxChars) {
      kept[kept.length - 1] = { ...last, content: clipMiddle(last.content, maxChars, "Recortado para caber en la ventana del modelo") }
    }
  }
  if (kept.length === messages.length && kept[kept.length - 1] === last) return messages
  return kept
}

// ── Messages inside a tool loop ───────────────────────────────────────────────

/**
 * A unit is the smallest slice that can be dropped without breaking the
 * conversation's shape: an assistant message that called tools goes together
 * with the tool results answering it (a result without its call is a 400).
 */
function toUnits(messages: LLMMessage[]): LLMMessage[][] {
  const units: LLMMessage[][] = []
  for (const message of messages) {
    const previous = units[units.length - 1]
    if (message.role === "tool" && previous && previous[0].role === "assistant") previous.push(message)
    else units.push([message])
  }
  return units
}

const unitTokens = (unit: LLMMessage[]) => unit.reduce((sum, m) => sum + messageTokens(m), 0)

export interface LoopFit {
  messages: LLMMessage[]
  /** Messages dropped, for the log. */
  dropped: number
  /** Estimated tokens after fitting. */
  tokens: number
}

/**
 * Fit a run's messages into `budget` tokens, oldest first.
 *
 * Never dropped: system messages, the last user message (the objective), and
 * the most recent unit (what the model has to react to). If dropping is not
 * enough, the biggest remaining tool results are clipped.
 *
 * Returns a new array; the caller's full history stays intact for persistence
 * and checkpoints.
 */
export function fitLoopMessages(messages: LLMMessage[], budget: number): LoopFit {
  let total = messages.reduce((sum, m) => sum + messageTokens(m), 0)
  if (total <= budget) return { messages, dropped: 0, tokens: total }

  const units = toUnits(messages)
  let lastUser = -1
  units.forEach((unit, i) => { if (unit[0].role === "user") lastUser = i })
  const isProtected = (i: number) => units[i][0].role === "system" || i === lastUser || i === units.length - 1

  const dropped = new Set<number>()
  let droppedMessages = 0
  for (let i = 0; i < units.length && total > budget; i++) {
    if (isProtected(i)) continue
    total -= unitTokens(units[i])
    droppedMessages += units[i].length
    dropped.add(i)
  }

  let remaining = units.filter((_, i) => !dropped.has(i)).flat()

  // A model turn cannot be the first thing after the system prompt.
  const firstIdx = remaining.findIndex(m => m.role !== "system")
  if (droppedMessages > 0 && firstIdx >= 0) {
    const first = remaining[firstIdx]
    if (first.role === "user" && typeof first.content === "string") {
      remaining = [
        ...remaining.slice(0, firstIdx),
        { ...first, content: `${first.content}\n\n[Se omitieron ${droppedMessages} mensajes anteriores para caber en la ventana de contexto.]` },
        ...remaining.slice(firstIdx + 1),
      ]
    }
  }

  // Still over: clip the largest tool results, biggest first.
  if (total > budget) {
    const order = remaining
      .map((m, i) => ({ i, tokens: m.role === "tool" ? messageTokens(m) : 0 }))
      .filter(entry => entry.tokens > 600)
      .sort((a, b) => b.tokens - a.tokens)
    for (const { i } of order) {
      if (total <= budget) break
      const message = remaining[i]
      if (typeof message.content !== "string") continue
      const before = messageTokens(message)
      const clipped = { ...message, content: clipMiddle(message.content, 2_000, "Resultado reducido para caber en la ventana") }
      remaining[i] = clipped
      total -= before - messageTokens(clipped)
    }
  }

  return { messages: remaining, dropped: droppedMessages, tokens: total }
}

/** Tokens a request may spend on messages: the window's share, minus the tool schemas. */
export function messageBudget(contextWindow: number | undefined, tools: unknown): number {
  const window = resolveWindow(contextWindow)
  const toolTokens = tools ? budgetTokens(JSON.stringify(tools)) : 0
  return Math.max(Math.floor(window * 0.25), Math.floor(window * COMPACT_RATIO) - toolTokens)
}
