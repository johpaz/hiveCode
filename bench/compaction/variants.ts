/**
 * Variantes de compactación a comparar.
 *
 *  - legacy:             el comportamiento ANTERIOR de compaction.ts: prompt de «3–5 oraciones»,
 *                        300 caracteres por mensaje, los últimos 30 mensajes de TODO el historial
 *                        y sin ver el resumen anterior (cada compactación olvida lo que quedó atrás).
 *  - legacy-incremental: el mismo prompt y límites, pero incorporando el resumen anterior y solo lo
 *                        nuevo. Aísla cuánto del cambio viene de la corrección incremental.
 *  - handoff-v1:         traspaso de seis campos con el prompt de la primera versión (sin reglas de conservación).
 *  - handoff:            el actual: traspaso de seis campos (handoff.ts), con sus reglas, límites nuevos e incremental.
 *
 * `legacy` y `legacy-incremental` reconstruyen código que ya no existe, así que su prompt vive aquí,
 * copiado del original. `handoff` usa las funciones reales de handoff.ts y los límites reales.
 */

import { COMPACTION_LIMITS, findCompactionCutIndex, renderTranscript } from "../../packages/core/src/agent/compaction"
import type { StoredMessage } from "../../packages/core/src/agent/conversation-store"
import {
  HANDOFF_SYSTEM_PROMPT,
  buildHandoffPrompt,
  parseHandoff,
  renderHandoff,
  type Handoff,
} from "../../packages/core/src/agent/handoff"
import type { PlantedItem, Scenario } from "./scenario"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasAll } from "./score"

/** Una llamada al modelo: sistema y usuario en, texto fuera. */
export type Llm = (system: string, user: string) => Promise<string>

export interface VariantResult {
  /** El texto que verá la siguiente instancia tras la última compactación. */
  summary: string
  /** Hasta qué mensaje (exclusivo) llegó la última compactación. */
  finalCutIndex: number
  calls: number
  failures: number
  /** Variantes sin resumen (recuperación): decide por dato si se habría encontrado. Sustituye a buscar en `summary`. */
  hasIt?: (item: PlantedItem) => boolean
  /** Tokens que verá el modelo, si no son los de `summary` (en la recuperación, lo que trae una consulta). */
  tokens?: number
}

export interface Variant {
  name: string
  description: string
  run(scenario: Scenario, llm: Llm): Promise<VariantResult>
}

const LEGACY_MAX_TRANSCRIPT_MSGS = 30
const LEGACY_MAX_MSG_CHARS = 300

const LEGACY_SYSTEM =
  "You are a conversation summarizer. Create a concise summary preserving: " +
  "user preferences, decisions made, important facts, tool results, and context needed to continue."

function toRows(scenario: Scenario, upTo: number): StoredMessage[] {
  return scenario.messages.slice(0, upTo).map((m) => ({
    id: m.id,
    thread_id: "bench",
    channel: "bench",
    role: m.role,
    content: m.content,
    tool_calls_json: null,
    tool_call_id: null,
    reasoning_content: null,
    content_multimodal: null,
    token_count: Math.ceil(m.content.length / 4),
    created_at: 0,
  }))
}

/** Tras cada tramo: el corte limpio y lo que hay que resumir hasta él. */
function cutAfter(scenario: Scenario, segmentEnd: number) {
  const rows = toRows(scenario, segmentEnd)
  const cut = findCompactionCutIndex(rows, COMPACTION_LIMITS.keepLastMessages)
  return { rows, cut, toSummarize: rows.slice(0, Math.max(0, cut)) }
}

function legacyVariant(incremental: boolean): Variant {
  return {
    name: incremental ? "legacy-incremental" : "legacy",
    description: incremental
      ? "Prompt de 3–5 oraciones, pero incorporando el resumen anterior y solo lo nuevo."
      : "Comportamiento anterior: 3–5 oraciones, últimos 30 mensajes de todo el historial, sin resumen previo.",
    async run(scenario, llm) {
      let summary = ""
      let lastId = 0
      let finalCutIndex = 0
      let calls = 0
      let failures = 0
      for (const end of scenario.segmentEnds) {
        const { toSummarize } = cutAfter(scenario, end)
        if (toSummarize.length === 0) continue
        const fresh = incremental ? toSummarize.filter((m) => m.id > lastId) : toSummarize
        if (fresh.length === 0) continue
        const transcript = renderTranscript(fresh.slice(-LEGACY_MAX_TRANSCRIPT_MSGS), LEGACY_MAX_MSG_CHARS)
        const user =
          incremental && summary
            ? `Existing summary of the earlier conversation:\n${summary}\n\nUpdate it with these ${fresh.length} new messages, in 3-5 sentences:\n\n${transcript}`
            : `Summarize this conversation (${toSummarize.length} messages) in 3-5 sentences:\n\n${transcript}`
        calls++
        try {
          const out = (await llm(LEGACY_SYSTEM, user)).trim()
          if (out) {
            summary = out
            lastId = toSummarize[toSummarize.length - 1]!.id
            finalCutIndex = toSummarize.length
          }
        } catch {
          failures++
        }
      }
      return { summary, finalCutIndex, calls, failures }
    },
  }
}

/** El prompt de usuario de la primera versión del traspaso, tal como se evaluó (sin reglas de conservación). */
function buildHandoffPromptV1(input: { transcript: string; messageCount: number; previous?: string | null }): string {
  const previous = input.previous?.trim()
  return [
    previous ? `Previous handoff (carry forward what is still true; drop what is obsolete):\n${previous}\n` : "",
    `New conversation to fold in (${input.messageCount} messages):\n${input.transcript}\n`,
    "Reply with ONLY this JSON object (same language as the conversation; one short line per item):",
    "{",
    '  "objective": "one line: the result the user wants",',
    '  "facts": ["established facts, kept EXACT: paths, ids, values, names, errors, user preferences and decisions"],',
    '  "changes": ["what was changed or created, and whether it was verified"],',
    '  "verification": ["checks run and their outcome"],',
    '  "dead_ends": ["approaches that failed and must not be repeated, with why"],',
    '  "plan": ["remaining steps in order; the first is the immediate next step"]',
    "}",
    "Use [] for a field with nothing to report. Never invent facts; separate what was observed from what is only an idea.",
  ].filter(Boolean).join("\n")
}

function handoffVariant(name: string, description: string, buildPrompt: typeof buildHandoffPrompt): Variant {
  return {
  name,
  description,
  async run(scenario, llm) {
    let previous: Handoff | null = null
    let previousText = ""
    let lastId = 0
    let finalCutIndex = 0
    let calls = 0
    let failures = 0
    for (const end of scenario.segmentEnds) {
      const { toSummarize } = cutAfter(scenario, end)
      const fresh = toSummarize.filter((m) => m.id > lastId)
      if (fresh.length === 0) continue
      const capped = fresh.slice(-COMPACTION_LIMITS.maxTranscriptMsgs)
      const rendered = renderTranscript(capped, COMPACTION_LIMITS.maxMsgChars)
      const transcript =
        rendered.length > COMPACTION_LIMITS.maxTranscriptChars
          ? rendered.slice(-COMPACTION_LIMITS.maxTranscriptChars)
          : rendered
      const user = buildPrompt({
        transcript,
        messageCount: capped.length,
        previous: previous ? renderHandoff(previous) : previousText || null,
      })
      calls++
      try {
        const raw = (await llm(HANDOFF_SYSTEM_PROMPT, user)).trim()
        if (!raw) continue
        const parsed = parseHandoff(raw)
        if (!parsed && /^[`{[]/.test(raw)) {
          failures++ // JSON roto: el hilo queda sin compactar, igual que en compaction.ts
          continue
        }
        previous = parsed
        previousText = parsed ? "" : raw
        lastId = toSummarize[toSummarize.length - 1]!.id
        finalCutIndex = toSummarize.length
      } catch {
        failures++
      }
    }
    const summary = previous ? renderHandoff(previous) : previousText
    return { summary, finalCutIndex, calls, failures }
  },
  }
}

const RECALL_K = 3

/**
 * Sin modelo: los mensajes se guardan como en el uso real (se indexan al guardarse) y, para cada dato, se
 * busca con la pregunta y se mira si lo esperado aparece entre los 3 mensajes que trae. Cero llamadas.
 *
 * Es una cota optimista: la consulta es la pregunta que se hizo con el dato delante, y en el uso real la
 * consulta es lo que dice la persona. Mide si el índice encuentra el dato cuando se le pregunta bien, no
 * si el modelo preguntará bien. Solo ve los mensajes anteriores al último corte, como el resto de variantes.
 */
function recallVariantOf(name: string, description: string, field: "question" | "paraphrase"): Variant {
  return {
  name,
  description,
  async run(scenario) {
    const { addMessage } = await import("../../packages/core/src/agent/conversation-store")
    const { indexMessage, searchThreadMessages } = await import("../../packages/core/src/agent/message-memory")
    const { closeHiveDb } = await import("../../packages/core/src/storage/hivedb")
    const { ensureHiveDb } = await import("../../packages/core/src/storage/bootstrap")
    const previous = process.env.HIVE_DB_PATH
    closeHiveDb()
    process.env.HIVE_DB_PATH = join(mkdtempSync(join(tmpdir(), "hivecode-bench-recall-")), "db")
    try {
      await ensureHiveDb()
      const thread = `bench-${scenario.seed}`
      for (const m of scenario.messages) {
        await addMessage(thread, m.role, m.content, { channel: "bench" })
        await indexMessage(thread, m.id, m.role, m.content) // determinista: no esperar al segundo plano
      }
      const lastEnd = scenario.segmentEnds[scenario.segmentEnds.length - 1]!
      const { cut } = cutAfter(scenario, lastEnd)
      const found = new Map<string, string>()
      let tokenSum = 0
      let queries = 0
      for (const item of scenario.items.filter((i) => i.messageIndex < cut)) {
        const hits = (await searchThreadMessages(thread, item[field], RECALL_K * 2))
          .filter((h) => h.message.id <= cut)
          .slice(0, RECALL_K)
        const text = hits.map((h) => h.message.content).join("\n")
        found.set(item.id, text)
        tokenSum += Math.ceil(text.length / 4)
        queries++
      }
      return {
        summary: "",
        finalCutIndex: cut,
        calls: 0,
        failures: 0,
        hasIt: (item) => hasAll(found.get(item.id) ?? "", item.expect),
        tokens: queries ? Math.round(tokenSum / queries) : 0,
      }
    } finally {
      closeHiveDb()
      if (previous === undefined) delete process.env.HIVE_DB_PATH
      else process.env.HIVE_DB_PATH = previous
    }
  },
  }
}

const recallVariant = recallVariantOf(
  "recall",
  "Sin modelo: los mensajes se indexan al guardarse y se recuperan por búsqueda (3 por consulta).",
  "question",
)
/**
 * Igual, pero la consulta es una paráfrasis: casi sin palabras en común con la frase plantada. Con solo BM25
 * (sin embeddings) es la cota pesimista; con embeddings activos debería acercarse a `recall`.
 */
const recallParaphraseVariant = recallVariantOf(
  "recall-paraphrase",
  "Sin modelo, con la pregunta parafraseada (sin las palabras del mensaje original).",
  "paraphrase",
)

export const VARIANTS: Variant[] = [
  recallVariant,
  recallParaphraseVariant,
  legacyVariant(false),
  legacyVariant(true),
  handoffVariant("handoff-v1", "Traspaso de seis campos con el prompt de la primera versión.", buildHandoffPromptV1),
  handoffVariant("handoff", "Actual: traspaso de seis campos con reglas de conservación, límites nuevos e incremental.", buildHandoffPrompt),
]
