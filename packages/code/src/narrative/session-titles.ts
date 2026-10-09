/**
 * Session naming — a session's display name is its user's request.
 *
 * `Scribe.createTurn` stamps a provisional title (the first user message,
 * truncated) so a session is never nameless in the picker. This module refines
 * that provisional into a short title with one cheap background LLM call, so
 * the picker reads "arregla el login OAuth" instead of a 120-character wall
 * of text.
 *
 * The guard is stateless and restart-safe: the namer only writes while the
 * stored title is still the provisional one — byte-for-byte
 * `firstTurn.user_message.slice(0, 120)`. Once an LLM title lands, the
 * comparison fails and no later task renames the session. If the call fails,
 * the provisional survives and the next task retries.
 */
import { col, ensureIndexes, updateDoc } from "@johpaz/hivecode-core/storage/hive"
import type { AgentDoc, CodeConfigDoc, CodeSessionDoc, CodeTurnDoc } from "@johpaz/hivecode-core/storage/collections"
import { fromIndexable } from "@johpaz/hivecode-core/storage/hive"
import { callLLM, resolveProviderConfig } from "@johpaz/hivecode-core/agent/llm-client"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import { shortId } from "@johpaz/hivecode-core/storage/ids"
import { PROVISIONAL_TITLE_LIMIT } from "./scribe"

const log = logger.child("session-titles")

/** A title is a line, not a paragraph. */
const MAX_TITLE_CHARS = 80
/** 3-6 words plus slack. See the note on the call below for why it is capped. */
const TITLE_MAX_TOKENS = 64

/**
 * The indexes the naming path queries. `createIndex` is idempotent (bootstrap.ts
 * runs the same calls on every boot), so this is a no-op on a bootstrapped
 * database and a self-heal on a fresh one.
 */
const NAMING_INDEXES: ReadonlyArray<readonly [string, string]> = [
  ["codeTurns", "session_id"],
  ["agents", "role"],
]

/**
 * Strip the decorations a model tends to add around a title: wrapping quotes,
 * a "Título:" prefix, trailing punctuation, and any second line.
 */
function sanitizeTitle(raw: string): string | null {
  let title = raw.trim().split("\n")[0] ?? ""
  title = title.trim()
  title = title.replace(/^[«"'“”`]+/, "").replace(/[»"'“”`]+$/, "").trim()
  title = title.replace(/^(t[íi]tulo|title)\s*[:\-—]\s*/i, "")
  title = title.replace(/[.!?…]+$/, "").trim()
  title = title.replace(/\s+/g, " ")
  if (!title) return null
  return title.slice(0, MAX_TITLE_CHARS)
}

/**
 * One naming call: the user's request in, a short title out. Injectable so
 * tests can stub the model without `mock.module`, which is process-global in
 * Bun and would leak into every later test file's LLM calls.
 */
export type TitleLLM = (userMessage: string) => Promise<{ content: string; stop_reason: string }>

/** The production call — resolves its own provider, same precedence as compaction.ts. */
const defaultTitleLLM: TitleLLM = async (userMessage) => {
  await ensureIndexes(NAMING_INDEXES)
  const coordinator = (await (await col<AgentDoc>("agents")).findBy("role", "coordinator"))[0]?.doc

  let provider = fromIndexable(coordinator?.provider_id)
  let model = fromIndexable(coordinator?.model_id)
  if (!provider || !model) {
    const codeConfig = await col<CodeConfigDoc>("codeConfig")
    const fallbackProvider = (await codeConfig.get("default_provider"))?.doc.value || "gemini"
    provider = provider || fallbackProvider
    model = model || (await codeConfig.get(`provider_model_${fallbackProvider}`))?.doc.value || "gemini-2.5-flash"
  }

  const providerCfg = await resolveProviderConfig(provider, model)
  const response = await callLLM({
    ...providerCfg,
    // A title is a handful of tokens. Without these two a reasoning model
    // spends the entire budget thinking and returns nothing: measured on
    // Qwen3.6-35B-A3B, 1228 tokens and 22 s produced an EMPTY answer, and the
    // cap alone only made it fail faster. With thinking off the same call
    // answers in 8 tokens and ~1.5 s.
    maxTokens: TITLE_MAX_TOKENS,
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    messages: [
      {
        role: "system",
        content:
          "Nombras sesiones de trabajo. Recibes el primer mensaje de un usuario a un agente de código " +
          "y devuelves UN título de 3 a 6 palabras en el idioma del mensaje. " +
          "Solo el título: sin comillas, sin punto final, sin prefijos como «Título:», sin explicación.",
      },
      { role: "user", content: userMessage.slice(0, 2000) },
    ],
  })
  return { content: response.content, stop_reason: response.stop_reason }
}

/**
 * Name a session from its first user message, in the background. Fire-and-
 * forget: never throws to the caller, never blocks a task, and a failure
 * simply leaves the provisional title in place.
 */
export async function nameSessionFromFirstMessage(
  sessionId: string,
  callTitleLLM: TitleLLM = defaultTitleLLM,
): Promise<void> {
  const session = (await (await col<CodeSessionDoc>("codeSessions")).get(sessionId))?.doc
  if (!session) return

    await ensureIndexes(NAMING_INDEXES)
  const turns = await col<CodeTurnDoc>("codeTurns")
  const firstTurn = (await turns.findBy("session_id", sessionId))
    .map((entry) => entry.doc)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
  if (!firstTurn) return

  const provisional = firstTurn.user_message.slice(0, PROVISIONAL_TITLE_LIMIT)
  // Empty title: a pre-field session getting its first post-upgrade task —
  // name it from its original request. Provisional: refine it. Anything else
  // is already named; leave it alone.
  if (session.title && session.title !== provisional) return

  const response = await callTitleLLM(firstTurn.user_message)

  // An error surfaces as content with stop_reason "error" — never save that.
  if (response.stop_reason === "error") {
    log.warn(`[session-titles] Naming call failed for ${shortId(sessionId)} — keeping provisional title`)
    return
  }

  const title = sanitizeTitle(response.content)
  if (!title || title === session.title) return

  await updateDoc<CodeSessionDoc>("codeSessions", sessionId, { title })
  log.info(`[session-titles] Session ${shortId(sessionId)} named: ${title}`)
}
