/**
 * Jev — the optional decision plane.
 *
 * Jev answers batched probabilistic questions about a plan (which history
 * items, tools, skills or results are still needed; whether tool calls may run
 * concurrently; what to do next) in a single round-trip, for a fraction of what
 * a full agent turn costs. The agent loop asks it before paying for context it
 * does not need.
 *
 * It is never on the critical path: every entry point returns null when the
 * service is unreachable, unconfigured or cooling down, and the caller keeps its
 * pre-Jev behavior. That is the whole contract.
 *
 * Puntuación, umbrales y guardasplatesported from the hive implementation; see
 * jev-planner.ts for what each decision buys.
 */
import { col } from "../storage/hive"
import type { ProviderDoc } from "../storage/collections"
import { getProviderApiKey } from "../storage/crypto"
import { recordJevDecision, recordUsage } from "../storage/usage"
import { logger } from "../utils/logger"
import { eventBus } from "../events/event-bus"

const log = logger.child("jev-decisions")

export const JEV_MODEL = "typesafe/jev-1.13"
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
const TIMEOUT_MS = 3000
const COOLDOWN_MS = 60_000
let failures = 0
let cooldownUntil = 0
let lastError: string | null = null
let lastSuccessAt: number | null = null
let decisionSequence = 0
/** Since process boot; the dashboard shows them as the oracle's running contribution. */
const totals = { decisions: 0, savedTokens: 0, costUsd: 0 }

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }

export interface JevResult {
  answers: Record<string, JevAnswer>
  inputTokens: number
  costUsd: number
  latencyMs: number
}

export interface JevStatus {
  state: "off" | "ready" | "fallback"
  lastError: string | null
  lastSuccessAt: number | null
  totals: { decisions: number; savedTokens: number; costUsd: number }
}

/** Catalog key for usage rows: same `provider/model` shape as every other model id. */
function catalogModelKey(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`
}

export async function getJevKey(): Promise<string | null> {
  const provider = await (await col<ProviderDoc>("providers")).get("openrouter")
  if (!provider?.doc.enabled || !provider.doc.active) return null
  return await getProviderApiKey("openrouter")
}

export async function getJevStatus(): Promise<JevStatus> {
  const key = await getJevKey().catch(() => null)
  return {
    state: !key ? "off" : Date.now() < cooldownUntil || lastError ? "fallback" : "ready",
    lastError: key ? lastError : null,
    lastSuccessAt: key ? lastSuccessAt : null,
    totals: { ...totals },
  }
}

function broadcastStatus(): void {
  getJevStatus()
    .then((status) => eventBus.emit("jev:status", status))
    .catch(() => { /* best effort: status is observability, never a hard dependency */ })
}

/**
 * Publishes a served decision and persists it. Callers estimate savings; Jev
 * itself only answers questions. `provider`/`model` are the advised agent's own
 * model, used to price the avoided tokens.
 */
export function emitJevDecision({
  provider, model, ...decision
}: {
  agentId: string
  provider: string
  model: string
  kind: string
  summary: string
  savedTokens: number
  costUsd: number
  latencyMs: number
}): void {
  recordJevDecision({ agentId: decision.agentId, provider, model, savedTokens: decision.savedTokens, costUsd: decision.costUsd })
  totals.decisions++
  totals.savedTokens += decision.savedTokens
  totals.costUsd += decision.costUsd
  eventBus.emit("jev:decision", {
    agentId: decision.agentId,
    provider,
    model,
    kind: decision.kind,
    summary: decision.summary.slice(0, 160),
    savedTokens: decision.savedTokens,
    costUsd: decision.costUsd,
    latencyMs: decision.latencyMs,
    eventId: `jev:${Date.now().toString(36)}:${++decisionSequence}`,
    totals: { ...totals },
  })
}

export function resetJevStatus(): void {
  failures = 0
  cooldownUntil = 0
  lastError = null
  lastSuccessAt = null
  broadcastStatus()
}

/**
 * One batched decision round-trip. Returns null on any failure — no key,
 * cooling down, transport error, malformed answer, or timeout — and the caller
 * proceeds exactly as it would have without Jev.
 */
export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<JevResult | null> {
  const key = await getJevKey().catch(() => null)
  if (!key || Date.now() < cooldownUntil || Object.keys(questions).length === 0) return null
  const started = performance.now()
  try {
    const response = await (options.fetcher ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      // Auth failures are terminal for the key: cool down instead of retrying
      // every turn against a credential that will keep failing.
      if (response.status === 401 || response.status === 403) cooldownUntil = Date.now() + COOLDOWN_MS
      throw new Error(`OpenRouter HTTP ${response.status}`)
    }
    const data = await response.json() as {
      answers?: Record<string, JevAnswer>
      usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
    }
    const answers: Record<string, JevAnswer> = {}
    // Every asked question must come back well-formed. A partial answer set is a
    // failure, not a partial result: acting on half of a pruning decision would
    // drop context on a guess.
    for (const [name, question] of Object.entries(questions)) {
      const answer = data.answers?.[name]
      if (question.type === "choice") {
        if (answer?.type !== "choice" || !Object.hasOwn(question.criteria, answer.choice) ||
          !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
          throw new Error(`Invalid choice answer: ${name}`)
        }
      } else if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
        throw new Error(`Invalid noul answer: ${name}`)
      }
      answers[name] = answer
    }
    const recovered = lastError !== null
    failures = 0
    lastError = null
    lastSuccessAt = Date.now()
    if (recovered) broadcastStatus()
    const inputTokens = data.usage?.input_tokens ?? 0
    const costUsd = data.usage?.cost ?? inputTokens * 0.042 / 1_000_000
    log.info(`Decision served: questions=${Object.keys(questions).join(",")} latency_ms=${Math.round(performance.now() - started)} input_tokens=${inputTokens} cost_usd=${costUsd}`)
    if (inputTokens > 0) {
      recordUsage({
        provider: "openrouter",
        model: catalogModelKey("openrouter", JEV_MODEL),
        inputTokens,
        outputTokens: data.usage?.output_tokens ?? 0,
        latencyMs: Math.round(performance.now() - started),
      })
    }
    return { answers, inputTokens, costUsd, latencyMs: Math.round(performance.now() - started) }
  } catch (error) {
    if (options.signal?.aborted) return null
    failures++
    lastError = error instanceof Error ? error.message : "Jev unavailable"
    if (failures >= 3) cooldownUntil = Date.now() + COOLDOWN_MS
    log.warn(`Decision fallback: ${lastError}`)
    broadcastStatus()
    return null
  }
}