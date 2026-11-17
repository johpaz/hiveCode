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
  getMessagesAfter,
  getSummary,
  saveSummary,
  toAPIMessages,
  getMessageCount,
  type StoredMessage,
} from "./conversation-store"
import { estimateTokens } from "../utils/llm-text"
import { callLLM, resolveProviderConfig, type ContentPart } from "./llm-client"
import { col, fromIndexable } from "../storage/hive"
import type { AgentDoc, CodeConfigDoc, ModelDoc } from "../storage/collections"
import { loadConfig } from "../config/loader"
import { COMPACT_RATIO, resolveWindow } from "./context-budget"
import { indexThreadMessages } from "./message-memory"
import { HANDOFF_SYSTEM_PROMPT, buildHandoffPrompt, parseHandoff, renderHandoff } from "./handoff"

const log = logger.child("compaction")

// Token budget: compress when stored tokens exceed this threshold
// Umbral cuando no se conoce la ventana del modelo. Con la ventana conocida el umbral es proporcional a ella
// (`resolveCompactionThreshold`): un valor fijo compactaba al 5 % de un modelo de 128K y tarde en uno de 8K.
const COMPACT_TOKEN_THRESHOLD = 6000
const ASSUMED_CONTEXT_WINDOW = 128_000 // ventana que se asume para leer una proporción cuando no se conoce la real
// La compactación bloquea el turno: pasado este límite el turno sigue sin compactar (el compilador ya recorta el
// historial a la ventana, así que nada desborda).
const COMPACTION_TIMEOUT_MS = 60_000
const KEEP_LAST_N_MESSAGES = 5         // always keep most recent N messages
const TOOL_RESULT_MAX_CHARS = 600      // max chars for old tool results after clearing
/**
 * Results that carry a worker's delivery. They are the coordinator's evidence for what to do next, and clipping them to a
 * head of 600 chars made it read the code itself to recover what the scout had already reported.
 */
const DELIVERY_TOOLS = new Set(["task_delegate", "task_revise", "task_status"])
const MAX_TRANSCRIPT_MSGS = 40         // cap messages sent to summarizer (avoids OOM on small models)
const MAX_MSG_CHARS = 800              // chars per message in transcript (300 cortaba rutas, ids y errores)
const MAX_TRANSCRIPT_CHARS = 24_000    // ~6K tokens: tope de la transcripción entera (modelos locales pequeños)

/** Los límites de la compactación, expuestos para que el benchmark (bench/compaction) mida con los mismos valores. */
export const COMPACTION_LIMITS = {
  keepLastMessages: KEEP_LAST_N_MESSAGES,
  maxTranscriptMsgs: MAX_TRANSCRIPT_MSGS,
  maxMsgChars: MAX_MSG_CHARS,
  maxTranscriptChars: MAX_TRANSCRIPT_CHARS,
} as const

/**
 * Tokens del historial VIVO: el resumen más lo posterior a él. Los mensajes ya resumidos siguen guardados
 * (auditoría) pero el modelo no los lee; contarlos haría que, pasado el umbral una vez, se recompactara
 * cada pocos turnos.
 */
async function liveTokens(threadId: string): Promise<number> {
  const summary = await getSummary(threadId)
  if (!summary) return getTotalTokens(threadId)
  const after = await getMessagesAfter(threadId, summary.last_message_id)
  return estimateTokens(summary.summary) + after.reduce((sum, m) => sum + m.token_count, 0)
}

/**
 * La compactación con modelo es el ÚLTIMO recurso: antes de ella, lo que sale de la ventana ya se recupera sin
 * modelo (libro de trabajo, historial indexado, `conversation_read`; ver work-ledger.ts). Por eso el umbral es
 * alto: un proyecto de código necesita tener a la vista cuanto más pueda, y cada compactación pierde detalle.
 */
export const DEFAULT_COMPACTION_RATIO = 0.8
/** Parte fija del prompt (sistema, herramientas, skills) que se supone si aún no se ha medido; BEE mide ~9,4K. */
const DEFAULT_FIXED_TOKENS = 10_000
/** Por debajo de esto no merece una llamada al modelo. */
const MIN_COMPACT_HISTORY_TOKENS = 2_000
/** Margen sobre el presupuesto de historial del compilador: compactar antes de que empiece a descartar turnos. */
const BUDGET_SAFETY = 0.9

/**
 * A partir de cuántos tokens de HISTORIAL se compacta.
 *
 * `agent.context.compactionThreshold` ≤ 1 es la parte del espacio útil de entrada que puede ocupar el
 * contexto TOTAL del turno (sistema + herramientas + historial); por defecto 0,8. El espacio útil es la
 * ventana por `COMPACT_RATIO`: el resto es la respuesta y el error de estimación. Como la parte fija no se
 * puede compactar, al historial le toca lo que queda: `ratio × útil − fijo`. Un valor > 1 son tokens de
 * historial, sin más cálculo.
 *
 * Tres protecciones: nunca por encima del 90 % del presupuesto de historial del compilador (si no, este
 * descartaría turnos antiguos SIN resumirlos antes de que llegara la compactación); nunca por debajo de
 * 2000 tokens (con una parte fija enorme compactaría en cada turno sin ganar nada); y sin ventana conocida,
 * 6000 tokens.
 */
export function resolveCompactionTrigger(o: { configured?: number; window?: number; fixedTokens?: number }): number {
  const { configured } = o
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 1) return Math.floor(configured)
  const known = o.window && o.window > 0 ? o.window : undefined
  const ratio = typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_COMPACTION_RATIO
  if (!known && configured === undefined) return COMPACT_TOKEN_THRESHOLD
  const window = resolveWindow(known ?? ASSUMED_CONTEXT_WINDOW)
  const fixed = Math.min(Math.max(0, o.fixedTokens ?? DEFAULT_FIXED_TOKENS), Math.floor(window * 0.5))
  const budget = Math.max(Math.floor(window * 0.25), Math.floor(window * COMPACT_RATIO) - fixed)
  const ceiling = Math.floor(budget * BUDGET_SAFETY)
  const raw = Math.floor(ratio * window * COMPACT_RATIO) - fixed
  return Math.min(ceiling, Math.max(MIN_COMPACT_HISTORY_TOKENS, raw))
}

/**
 * Cuánto de lo acumulado ve el resumen en UNA llamada, según la ventana. Con umbrales altos se acumulan
 * decenas de miles de tokens; un tope fijo de 40 mensajes dejaba al resumen ver una fracción. Se crece con
 * la ventana (un modelo local pequeño sigue con los topes de siempre) y sigue siendo una sola llamada.
 */
export function transcriptLimits(window?: number): { maxMsgs: number; maxChars: number } {
  const w = resolveWindow(window)
  const maxChars = Math.min(100_000, Math.max(MAX_TRANSCRIPT_CHARS, Math.floor(w * 0.1 * 3.5)))
  const maxMsgs = Math.min(160, Math.max(MAX_TRANSCRIPT_MSGS, Math.floor(maxChars / 600)))
  return { maxMsgs, maxChars }
}

/** Ventana del modelo del coordinador, si se conoce. */
async function coordinatorContextWindow(): Promise<number | undefined> {
  try {
    const agentsCol = await col<AgentDoc>("agents")
    const modelId = fromIndexable((await agentsCol.findBy("role", "coordinator", { limit: 1 }))[0]?.doc.model_id ?? null)
    if (!modelId) return undefined
    return (await (await col<ModelDoc>("models")).get(modelId))?.doc.context_window ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Check if compaction is needed and run it if so.
 * Called at the start of each agent loop iteration.
 */
export async function maybeCompact(
  threadId: string,
  notify?: { channel: string; userId: string },
  /** La ventana que el proveedor realmente lee (`resolveProviderConfig`); manda sobre la fila del modelo. */
  contextWindow?: number,
  /** La señal del turno: cancelarlo cancela también su compactación. */
  signal?: AbortSignal,
  /** Tokens de la parte fija del prompt (sistema, herramientas, skills), si ya se midieron en este run. */
  fixedTokens?: number,
): Promise<void> {
  try {
    const totalTokens = await liveTokens(threadId)
    const threshold = resolveCompactionTrigger({
      configured: loadConfig().agent?.context?.compactionThreshold,
      window: contextWindow ?? (await coordinatorContextWindow()),
      fixedTokens,
    })
    if (totalTokens < threshold) return

    const summary = await getSummary(threadId)
    const totalMessages = await getMessageCount(threadId)

    // Already summarized up to near the current state
    if (summary && summary.last_message_id > totalMessages - KEEP_LAST_N_MESSAGES) return

    log.info(`[compaction] Compacting thread=${threadId} tokens=${totalTokens} threshold=${threshold}`)
    const timeout = AbortSignal.timeout(COMPACTION_TIMEOUT_MS)
    await compactThread(threadId, notify, signal ? AbortSignal.any([signal, timeout]) : timeout)
  } catch (err) {
    log.warn("[compaction] Error during compaction check:", err)
  }
}

/**
 * Find a clean cut point: the "keep" side must begin with a user turn so we never leave orphaned tool messages at
 * the start of the visible window. Returns 0 when no clean boundary exists (the caller skips compaction).
 */
export function findCompactionCutIndex(rows: Array<{ role: string }>, keepLastN = KEEP_LAST_N_MESSAGES): number {
  let cutIndex = rows.length - keepLastN
  while (cutIndex > 0 && rows[cutIndex]?.role !== "user") {
    cutIndex--
  }
  return cutIndex
}

/** Render a transcript for the summarizer LLM (multimodal parts reduced to their text). */
export function renderTranscript(rows: StoredMessage[], maxMsgChars = MAX_MSG_CHARS): string {
  return toAPIMessages(rows)
    .map((m) => {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter(p => p.type === "text").map(p => (p as any).text).join("\n")
          : ""
      return `[${m.role.toUpperCase()}]: ${text.substring(0, maxMsgChars)}`
    })
    .join("\n\n")
}

/**
 * Compress a thread's history into a summary.
 */
export async function compactThread(
  threadId: string,
  notify?: { channel: string; userId: string },
  signal?: AbortSignal,
): Promise<void> {
  // Solo lo posterior al resumen anterior: ese ya está en su traspaso. `getHistory()` devolvía los 200
  // mensajes MÁS ANTIGUOS, así que en un hilo largo cada compactación veía el mismo corte que la primera
  // y la compactación dejaba de avanzar pasado el mensaje ~200.
  const existingSummary = await getSummary(threadId)
  const allMessages = await getMessagesAfter(threadId, existingSummary?.last_message_id ?? -1)
  if (allMessages.length <= KEEP_LAST_N_MESSAGES) return

  const cutIndex = findCompactionCutIndex(allMessages)
  if (cutIndex <= 0) {
    log.info(`[compaction] No clean user-turn boundary found — skipping`)
    return
  }

  const toSummarize = allMessages.slice(0, cutIndex)
  if (toSummarize.length === 0) return

  const lastSummarizedId = toSummarize[toSummarize.length - 1].id

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

  // Cap transcript to the model's window (se conserva la cola, lo más reciente)
  const limits = transcriptLimits(providerCfg.contextWindow)
  const capped = toSummarize.slice(-limits.maxMsgs)
  const rendered = renderTranscript(capped)
  const transcript = rendered.length > limits.maxChars ? rendered.slice(-limits.maxChars) : rendered
  const previous = existingSummary
    ? (existingSummary.structured ? renderHandoff(existingSummary.structured) : existingSummary.summary)
    : null

  const summaryResponse = await callLLM({
    ...providerCfg,
    signal,
    messages: [
      { role: "system", content: HANDOFF_SYSTEM_PROMPT },
      { role: "user", content: buildHandoffPrompt({ transcript, messageCount: capped.length, previous }) },
    ],
  })

  // Una llamada fallida devuelve el error como `content`: sin esta guarda el resumen que reemplaza N
  // mensajes de historial sería "[LLM Error] ...". Dejar el hilo sin compactar es recuperable; guardarlo, no.
  if (summaryResponse.stop_reason === "error") {
    log.warn(`[compaction] Summarizer call failed — keeping thread ${threadId} uncompacted`)
    return
  }

  const raw = summaryResponse.content.trim()
  if (!raw) return

  // Traspaso estructurado; si el modelo respondió prosa se guarda como resumen libre (formato anterior).
  // Si parece un JSON roto no se guarda: el hilo queda sin compactar, que es recuperable.
  const structured = parseHandoff(raw)
  if (!structured && /^[`{\[]/.test(raw)) {
    log.warn(`[compaction] Handoff JSON inválido para thread=${threadId} — se deja sin compactar`)
    return
  }
  const summary = structured ? renderHandoff(structured) : raw

  await saveSummary(
    threadId, summary, (existingSummary?.messages_covered ?? 0) + toSummarize.length, lastSummarizedId, structured,
  )
  // Lo compactado sigue siendo recuperable: conversation_read lo busca en este índice (segundo plano).
  void indexThreadMessages(threadId, toSummarize)
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
 * - Never truncates the latest result of any given tool, nor any delegation result (`DELIVERY_TOOLS`)
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
    if (DELIVERY_TOOLS.has(toolNameForResult(messages, i))) return msg

    const head = msg.content.substring(0, TOOL_RESULT_MAX_CHARS)
    const looksStructured = msg.content.trim().startsWith("{") || msg.content.trim().includes(":")
    return {
      ...msg,
      content: looksStructured
        ? `[Resultado antiguo recortado (si algo de él importaba, debió quedar en tus notas): ${head}...]`
        : `[Resultado antiguo recortado: ${head}...]`,
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
  
  // Try to extract key result field from the rendered result
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
