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
import { HIVEAGENTS_BASE_URL } from "./llm-providers/hiveagents"

const log = logger.child("jev-decisions")

export const JEV_MODEL = "typesafe/jev-1.13"
export const KEV_MODEL = "kev"
const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
/** Kev shares a GPU with the chat model and starts with --no-warmup: its first answer is slower. */
const TIMEOUT_MS: Record<OracleKind, number> = { jev: 3000, kev: 5000 }
const COOLDOWN_MS = 60_000
/**
 * Kev serves an 8192-token context. State plus questions beyond this many
 * characters (~5.7k tokens at 3.5 chars/token, leaving room for the answers)
 * would be rejected upstream, so Kev is skipped instead of asked.
 */
export const KEV_MAX_REQUEST_CHARS = 20_000
/** Consecutive times the runtime found an oracle wrong before it is put aside. */
export const DISTRUST_STRIKES = 3
export const DISTRUST_MS = 5 * 60_000

export type OracleKind = "jev" | "kev"
export const ORACLE_PRIORITY: readonly OracleKind[] = ["jev", "kev"]

interface OracleState { failures: number; cooldownUntil: number; lastError: string | null; lastSuccessAt: number | null; strikes: number }
const oracleStates: Record<OracleKind, OracleState> = {
  jev: { failures: 0, cooldownUntil: 0, lastError: null, lastSuccessAt: null, strikes: 0 },
  kev: { failures: 0, cooldownUntil: 0, lastError: null, lastSuccessAt: null, strikes: 0 },
}
/** The oracle that served the last decision, so the status can name who is answering. */
let lastServedBy: OracleKind | null = null
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
  /** Which oracle answered. */
  oracle: OracleKind
}

export interface JevStatus {
  state: "off" | "ready" | "fallback"
  /** Which oracle answers now (Jev wins over Kev); null when neither is configured. */
  oracle: OracleKind | null
  lastError: string | null
  lastSuccessAt: number | null
  totals: { decisions: number; savedTokens: number; costUsd: number }
}

/** Catalog key for usage rows: same `provider/model` shape as every other model id. */
function catalogModelKey(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`
}

/** A decision server ready to be asked. Jev and Kev speak the same System One protocol. */
export interface ResolvedOracle {
  kind: OracleKind
  apiKey: string
  endpoint: string
  model: string
  /** Not OpenRouter's: no per-call tariff and the turn's text stays on HiveAgents' infrastructure. */
  selfHosted: boolean
}

async function activeProvider(id: string): Promise<ProviderDoc | null> {
  const row = await (await col<ProviderDoc>("providers")).get(id)
  return row?.doc.enabled && row.doc.active ? row.doc : null
}

async function resolveJev(): Promise<ResolvedOracle | null> {
  if (!await activeProvider("openrouter")) return null
  const apiKey = await getProviderApiKey("openrouter")
  return apiKey ? { kind: "jev", apiKey, endpoint: JEV_ENDPOINT, model: JEV_MODEL, selfHosted: false } : null
}

async function resolveKev(): Promise<ResolvedOracle | null> {
  const provider = await activeProvider("hiveagents")
  if (!provider) return null
  const apiKey = await getProviderApiKey("hiveagents")
  if (!apiKey) return null
  const base = (provider.base_url || HIVEAGENTS_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, "")
  return { kind: "kev", apiKey, endpoint: `${base}/v1/systemone`, model: KEV_MODEL, selfHosted: true }
}

/**
 * Every configured oracle, in priority order: Jev (OpenRouter) first, Kev
 * (HiveAgents) second. An empty list means the classic path runs.
 */
export async function resolveOracles(): Promise<ResolvedOracle[]> {
  const resolvers: Record<OracleKind, () => Promise<ResolvedOracle | null>> = { jev: resolveJev, kev: resolveKev }
  const found = await Promise.all(ORACLE_PRIORITY.map((kind) => resolvers[kind]().catch(() => null)))
  return found.filter((oracle): oracle is ResolvedOracle => oracle !== null)
}

/** Whether any oracle is configured. Callers use it to skip building questions nobody will answer. */
export async function hasOracle(): Promise<boolean> {
  return (await resolveOracles()).length > 0
}

function isAside(kind: OracleKind): boolean {
  return Date.now() < oracleStates[kind].cooldownUntil
}

export async function getJevStatus(): Promise<JevStatus> {
  const oracles = await resolveOracles().catch(() => [] as ResolvedOracle[])
  const serving = oracles.find((oracle) => !isAside(oracle.kind)) ?? oracles[0] ?? null
  const state = serving ? oracleStates[serving.kind] : null
  return {
    state: !serving ? "off" : isAside(serving.kind) || state?.lastError ? "fallback" : "ready",
    oracle: serving?.kind ?? null,
    lastError: state?.lastError ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
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
  for (const kind of ORACLE_PRIORITY) oracleStates[kind] = { failures: 0, cooldownUntil: 0, lastError: null, lastSuccessAt: null, strikes: 0 }
  lastServedBy = null
  broadcastStatus()
}

/**
 * The runtime found the oracle's decision wrong (e.g. it said "parallel" and the
 * calls collided). Enough consecutive strikes put the oracle that served it aside.
 */
export function recordOracleOverruled(reason: string): boolean {
  const kind = lastServedBy
  if (!kind) return false
  const state = oracleStates[kind]
  if (++state.strikes < DISTRUST_STRIKES) return false
  state.strikes = 0
  state.cooldownUntil = Date.now() + DISTRUST_MS
  state.lastError = `distrusted: ${reason}`
  log.warn(`${kind} put aside for ${DISTRUST_MS / 1000}s: ${reason}`)
  broadcastStatus()
  return true
}

export function recordOracleAgreement(): void {
  if (lastServedBy) oracleStates[lastServedBy].strikes = 0
}

/**
 * Jev answers `choice` with `{ choice, confidence }`; Kev with `{ choice, probabilities }`
 * and `noul` as `probability`. Accept both so the strict validation below stays strict.
 */
function normalizeAnswer(question: JevQuestion, raw: unknown): JevAnswer | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const answer = raw as Record<string, unknown>
  if (question.type === "choice") {
    const choice = answer.choice
    const probabilities = answer.probabilities as Record<string, number> | undefined
    const confidence = typeof answer.confidence === "number"
      ? answer.confidence
      : typeof choice === "string" ? probabilities?.[choice] : undefined
    return { type: "choice", choice: choice as string, confidence: confidence as number, probabilities: probabilities ?? {} }
  }
  const noul = typeof answer.noul === "number" ? answer.noul : answer.probability
  return { type: "noul", noul: noul as number }
}

/**
 * One batched decision round-trip. Oracles are tried in priority order (Jev,
 * then Kev); the first one that answers every question well-formed wins.
 * Returns null when none does — no oracle configured, all cooling down,
 * transport error, malformed answer or timeout — and the caller proceeds
 * exactly as it would have without an oracle.
 */
export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<JevResult | null> {
  if (Object.keys(questions).length === 0) return null
  for (const oracle of await resolveOracles().catch(() => [] as ResolvedOracle[])) {
    if (options.signal?.aborted) return null
    if (isAside(oracle.kind)) continue
    const result = await askOracle(oracle, state, questions, options)
    if (result) return result
  }
  return null
}

async function askOracle(
  oracle: ResolvedOracle,
  state: unknown,
  questions: Record<string, JevQuestion>,
  options: { fetcher?: typeof fetch; signal?: AbortSignal },
): Promise<JevResult | null> {
  const tracker = oracleStates[oracle.kind]
  const body = JSON.stringify({ model: oracle.model, state, questions })
  if (oracle.kind === "kev" && body.length > KEV_MAX_REQUEST_CHARS) {
    log.info(`kev skipped: request is ${body.length} chars, over its ${KEV_MAX_REQUEST_CHARS} context budget`)
    return null
  }
  const label = oracle.kind === "kev" ? "Kev" : "OpenRouter"
  const started = performance.now()
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS[oracle.kind])
    const response = await (options.fetcher ?? fetch)(oracle.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${oracle.apiKey}`, "Content-Type": "application/json" },
      body,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    })
    if (!response.ok) {
      // Auth failures are terminal for the key: cool down instead of retrying
      // every turn against a credential that will keep failing.
      if (response.status === 401 || response.status === 403) tracker.cooldownUntil = Date.now() + COOLDOWN_MS
      throw new Error(`${label} HTTP ${response.status}`)
    }
    const data = await response.json() as {
      answers?: Record<string, unknown>
      usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
    }
    const answers: Record<string, JevAnswer> = {}
    // Every asked question must come back well-formed. A partial answer set is a
    // failure, not a partial result: acting on half of a pruning decision would
    // drop context on a guess.
    for (const [name, question] of Object.entries(questions)) {
      const answer = normalizeAnswer(question, data.answers?.[name])
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
    const recovered = tracker.lastError !== null
    tracker.failures = 0
    tracker.lastError = null
    tracker.lastSuccessAt = Date.now()
    lastServedBy = oracle.kind
    if (recovered) broadcastStatus()
    const inputTokens = data.usage?.input_tokens ?? 0
    const latencyMs = Math.round(performance.now() - started)
    // A HiveAgents-hosted oracle costs nothing per call and has no OpenRouter tariff.
    const costUsd = oracle.selfHosted ? 0 : data.usage?.cost ?? inputTokens * 0.042 / 1_000_000
    log.info(`Decision served by ${oracle.kind}: questions=${Object.keys(questions).join(",")} latency_ms=${latencyMs} input_tokens=${inputTokens} cost_usd=${costUsd}`)
    if (inputTokens > 0 && !oracle.selfHosted) {
      recordUsage({
        provider: "openrouter",
        model: catalogModelKey("openrouter", JEV_MODEL),
        inputTokens,
        outputTokens: data.usage?.output_tokens ?? 0,
        latencyMs,
      })
    }
    return { answers, inputTokens, costUsd, latencyMs, oracle: oracle.kind }
  } catch (error) {
    if (options.signal?.aborted) return null
    tracker.failures++
    tracker.lastError = error instanceof Error ? error.message : `${label} unavailable`
    if (tracker.failures >= 3) tracker.cooldownUntil = Date.now() + COOLDOWN_MS
    log.warn(`${oracle.kind} fallback: ${tracker.lastError}`)
    broadcastStatus()
    return null
  }
}
