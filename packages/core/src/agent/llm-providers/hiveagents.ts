import { logger } from "../../utils/logger"
import { OpenAICompatBase } from "./openai-compat-base"
import type { LLMCallOptions, LLMResponse } from "./interface"

const log = logger.child("llm-client")

export const HIVEAGENTS_BASE_URL = "https://llm.hiveagents.io"
export const HIVEAGENTS_OPENAI_BASE_URL = `${HIVEAGENTS_BASE_URL}/v1`
/**
 * Modelo por defecto cuando quien llama no especifica uno.
 *
 * El id es el nombre exacto del fichero GGUF que monta el backend, así que debe
 * coincidir con una entrada de `GET /api/models`. Antes apuntaba a
 * `Qwen3-Coder-Next-UD-Q4_K_M.gguf`, que ya no existe en el servidor: cualquier
 * carga con ese id se quedaba esperando un readiness que nunca llegaba.
 * El backend marca Qwen3.6-35B-A3B como recomendado (62.7 t/s de generación).
 */
export const HIVEAGENTS_MODEL_ID = "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"

/**
 * Migration fallback only. At runtime the loader and every inference request
 * resolve context_window from the model record in HiveDB.
 */
export const HIVEAGENTS_DEFAULT_LOAD_CTX = 50000

const HIVEAGENTS_LOAD_FETCH_TIMEOUT_MS = 300000
const HIVEAGENTS_READY_TIMEOUT_MS = 300000
const HIVEAGENTS_STATUS_POLL_MS = 1000

// Cloudflare bloquea requests con el User-Agent de OpenAI SDK y headers x-stainless-*.
const BLOCKED_HEADERS = [
  "user-agent",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-arch",
  "x-stainless-os",
]

export interface HiveAgentsLoadResult {
  success: boolean
  loading?: boolean
  error?: string
}

export interface HiveAgentsStatusResult {
  loaded: boolean
  loading?: boolean
  error?: string | null
  model?: { name?: string; ctx?: number; n_ctx?: number }
}

export interface HiveAgentsReadyResult extends HiveAgentsLoadResult {
  status?: HiveAgentsStatusResult
}

function getApiBase(): string {
  return HIVEAGENTS_BASE_URL
}

/**
 * El backend identifica los modelos por el nombre del fichero GGUF. Aceptamos el id
 * con o sin el prefijo `hiveagents/` y caemos al modelo por defecto si no hay ninguno.
 */
export function resolveModelId(modelId?: string | null): string {
  const trimmed = modelId?.trim().replace(/^hiveagents\//, "") ?? ""
  return trimmed || HIVEAGENTS_MODEL_ID
}

function getAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  }
}

/**
 * Solicita la carga de un modelo GGUF en el backend de HiveAgents.
 * El backend monta un modelo a la vez; `modelId` decide cuál.
 */
export async function loadHiveAgentsModel(
  modelId: string,
  apiKey: string,
  _baseUrl?: string,
  ctx = HIVEAGENTS_DEFAULT_LOAD_CTX
): Promise<HiveAgentsLoadResult> {
  const apiBase = getApiBase()
  const headers = getAuthHeaders(apiKey)
  const loadBody = {
    model: modelId || HIVEAGENTS_MODEL_ID,
    config: {
      ctx,
      kvType: "f16",
      flashAttn: false,
      jinja: true,
    },
  }

  try {
    log.info(`[hiveagents] → POST ${apiBase}/api/load`)
    log.info(`[hiveagents] → Body: ${JSON.stringify(loadBody)}`)
    const res = await fetch(`${apiBase}/api/load`, {
      method: "POST",
      headers,
      body: JSON.stringify(loadBody),
      signal: AbortSignal.timeout(HIVEAGENTS_LOAD_FETCH_TIMEOUT_MS),
    })
    const responseText = await res.text().catch(() => "")
    if (!res.ok) {
      // 524 = Cloudflare timeout. 530 = Cloudflare Tunnel error. Ambos pueden ser transitorios.
      const isTransientCloudflareError = [502, 503, 504, 524, 530].includes(res.status)
      if (isTransientCloudflareError) {
        log.warn(`[hiveagents] ← Load request hit transient error (HTTP ${res.status}); backend may still be loading`)
        return { success: true, loading: true }
      }
      log.error(`[hiveagents] ← Load failed: HTTP ${res.status} ${res.statusText} — ${responseText}`)
      return { success: false, error: `Load failed: HTTP ${res.status} — ${responseText || res.statusText}` }
    }
    log.info(`[hiveagents] ← Load accepted: ${responseText}`)
    return { success: true }
  } catch (err) {
    const msg = (err as Error).message || ""
    // AbortError por timeout interno: el backend puede seguir cargando.
    if (msg.includes("timed out") || msg.includes("abort") || msg.includes("AbortError")) {
      log.warn(`[hiveagents] ← Load request timed out after ${HIVEAGENTS_LOAD_FETCH_TIMEOUT_MS}ms; backend may still be loading`)
      return { success: true, loading: true }
    }
    return { success: false, error: msg }
  }
}

/**
 * Consulta el estado actual del backend de HiveAgents.
 */
export async function getHiveAgentsModelStatus(
  _apiKey?: string,
  _baseUrl?: string
): Promise<HiveAgentsStatusResult> {
  const apiBase = getApiBase()

  try {
    const res = await fetch(`${apiBase}/api/status`)
    if (!res.ok) return { loaded: false }
    const data = await res.json() as any
    return {
      loaded: !!data.loaded,
      loading: !!data.loading,
      error: data.error ?? null,
      model: data.model,
    }
  } catch {
    return { loaded: false }
  }
}

export async function ensureHiveAgentsModelReady(
  apiKey: string,
  onStatus?: (status: HiveAgentsStatusResult) => void,
  pollIntervalMs = HIVEAGENTS_STATUS_POLL_MS,
  timeoutMs = HIVEAGENTS_READY_TIMEOUT_MS,
  ctx = HIVEAGENTS_DEFAULT_LOAD_CTX,
  modelId: string = HIVEAGENTS_MODEL_ID,
): Promise<HiveAgentsReadyResult> {
  const target = modelId || HIVEAGENTS_MODEL_ID
  let status = await getHiveAgentsModelStatus()
  onStatus?.(status)
  if (isExpectedModelReady(status, ctx, target)) {
    return { success: true, loading: false, status }
  }

  const load = await loadHiveAgentsModel(target, apiKey, undefined, ctx)
  if (!load.success) return load

  const deadline = Date.now() + timeoutMs
  let pollCount = 0
  while (Date.now() < deadline) {
    await Bun.sleep(pollIntervalMs)
    status = await getHiveAgentsModelStatus()
    onStatus?.(status)
    pollCount++
    if (pollCount % 5 === 0) {
      log.info(`[hiveagents] Waiting for ${target} to become ready`)
    }
    if (status.error) {
      return { success: false, loading: false, status, error: status.error }
    }
    if (isExpectedModelReady(status, ctx, target)) {
      log.info(`[hiveagents] ${target} is ready`)
      return { success: true, loading: false, status }
    }
  }

  return {
    success: false,
    loading: false,
    status,
    error: `Model load timed out after ${timeoutMs}ms`,
  }
}

function isExpectedModelReady(status: HiveAgentsStatusResult, ctx: number, modelId: string): boolean {
  if (!status.loaded || status.loading || status.model?.name !== modelId) {
    return false
  }
  const loadedCtx = status.model.ctx ?? status.model.n_ctx
  // Older server versions do not expose ctx in /api/status.
  return loadedCtx === undefined || loadedCtx === ctx
}

export class HiveAgentsProvider extends OpenAICompatBase {
  constructor() { super("hiveagents") }

  // Cloudflare WAF bloquea requests con headers x-stainless-* del SDK de OpenAI.
  // Los eliminamos mediante un fetch wrapper para que nunca lleguen al WAF.
  protected async resolveOpenAIClient(apiKey: string, baseURL: string | undefined): Promise<any> {
    const { default: OpenAI } = await import("openai")
    return new OpenAI({
      apiKey,
      baseURL,
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers as HeadersInit | undefined)
        for (const h of BLOCKED_HEADERS) headers.delete(h)

        const headersObj: Record<string, string> = {}
        headers.forEach((v, k) => { headersObj[k] = k.toLowerCase() === "authorization" ? `Bearer ••••${v.slice(-6)}` : v })
        log.info(`[hiveagents] → POST ${url}`)
        log.info(`[hiveagents] → Headers: ${JSON.stringify(headersObj)}`)
        if (init?.body) {
          try {
            const parsed = JSON.parse(init.body as string)
            const summary = { model: parsed.model, messages: parsed.messages?.length, tools: parsed.tools?.length, prompt_chars: (init.body as string).length, max_tokens: parsed.max_tokens, temperature: parsed.temperature, tool_choice: parsed.tool_choice, extra_body: parsed.extra_body }
            log.info(`[hiveagents] → Body summary: ${JSON.stringify(summary)}`)
          } catch { /* ignore */ }
        }

        const startedAt = performance.now()
        const res = await fetch(url, { ...init, headers })
        log.info(`[hiveagents] ← Response: ${res.status} ${res.statusText} (${Math.round(performance.now() - startedAt)}ms hasta la respuesta)`)
        return res
      },
    })
  }

  async call(options: LLMCallOptions): Promise<LLMResponse> {
    const model = resolveModelId(options.model)
    await this._ensureModelLoaded(options, model)
    const callOptions = {
      ...options,
      baseUrl: HIVEAGENTS_OPENAI_BASE_URL,
      model,
    }

    return super.call(callOptions)
  }

  // hiveCode usa los modelos de hiveagents como no-thinking (codificación), así que
// `enable_thinking` va siempre en false. El SDK hace lo contrario por familia de
// modelo (Qwen3.x / Gemma 4 / AgentWorld) y lo deja por defecto en true.
  //
  // `chat_template_kwargs` goes at the top level of the body. `extra_body` is a Python
  // SDK convention — the JS SDK forwards it verbatim as an unknown field, so nesting it
  // there made the flag a no-op and risked a 400, which falls into
  // retryWithoutToolsOnCodes and retries the call with every tool stripped.
  protected modifyRequestBody(body: any, _options: LLMCallOptions): any {
    body.chat_template_kwargs = {
      ...(body.chat_template_kwargs ?? {}),
      enable_thinking: false,
    }
    return body
  }

  private async _ensureModelLoaded(options: LLMCallOptions, modelId: string): Promise<void> {
    const result = await ensureHiveAgentsModelReady(
      options.apiKey,
      undefined,
      HIVEAGENTS_STATUS_POLL_MS,
      HIVEAGENTS_READY_TIMEOUT_MS,
      options.contextWindow ?? HIVEAGENTS_DEFAULT_LOAD_CTX,
      modelId,
    )
    if (!result.success) {
      throw new Error(`HiveAgents could not prepare ${modelId}: ${result.error}`)
    }
  }

}
