import { logger } from "../../utils/logger"
import {
  sanitizeMessages, requiresTemperature1, OPENAI_COMPAT_BASE_URLS,
  getProviderProfile, modelSupportsTools, normalizeToolName, normalizeToolSchema,
  resolveMaxTokens,
} from "./interface"
import type { LLMCallOptions, LLMProvider, LLMResponse, LLMToolCall } from "./interface"
import type { ContentPart, LLMMessage } from "../llm-client"

const log = logger.child("llm-client")

/** Matches both generic context overflow phrasing and llama.cpp's exceed_context_size_error shape. */
function isContextOverflowError(err: any, errMsg: string): boolean {
  const status = err?.status ?? err?.response?.status
  if (status !== 400) return false
  if (err?.error?.type === "exceed_context_size_error" || err?.type === "exceed_context_size_error") return true
  return errMsg.includes("context length") || errMsg.includes("input_tokens")
    || errMsg.includes("maximum input length") || errMsg.includes("context size")
}

/** llama.cpp-style errors report the server's real context size in n_ctx. */
function extractRealContextSize(err: any): number | undefined {
  return err?.error?.n_ctx ?? err?.n_ctx
}

/** Keeps the system prompt and the last third of messages, then shrinks max_tokens. */
function compactBodyForContextOverflow(body: any, err: any): void {
  const kept: any[] = []
  let systemMsg: any = null
  for (const m of body.messages) {
    if (m.role === "system") {
      systemMsg = m
      continue
    }
    kept.push(m)
  }

  const keepRatio = Math.max(1, Math.floor(kept.length / 3))
  const trimmed = kept.slice(-keepRatio)
  body.messages = systemMsg ? [systemMsg, ...trimmed] : trimmed

  const realCtx = extractRealContextSize(err)
  if (realCtx) {
    body.max_tokens = Math.min(body.max_tokens ?? realCtx, Math.floor(realCtx * 0.25))
  } else if (body.max_tokens) {
    body.max_tokens = Math.min(body.max_tokens, 4096)
  }
}

export abstract class OpenAICompatBase implements LLMProvider {
  constructor(protected readonly providerName: string) {}

  // ─── Overridable hooks ──────────────────────────────────────────────────────

  protected needsReasoningRoundtrip(): boolean {
    return false
  }

  protected isLocalProvider(): boolean {
    return false
  }

  /** Hook called before building the request body (e.g. auto-start local server). */
  protected async beforeCall(_options: LLMCallOptions): Promise<void> {
    // no-op by default
  }

  /** Hook called after getting the raw response, before return. */
  protected async afterCall(_response: LLMResponse, _options: LLMCallOptions): Promise<LLMResponse> {
    return _response
  }

  /**
   * Hook called after tools are prepared when sendTools is true.
   * Override for providers/models that need text-based tool-call instructions.
   */
  protected injectToolsIntoPrompt(_body: any, _preparedTools: any[]): void {
    // no-op by default
  }

  /** Override to add provider-specific fields to the request body. */
  protected modifyRequestBody(body: any, _options: LLMCallOptions): any {
    return body
  }

  /** Override to customize the OpenAI client (e.g. strip unwanted headers, add custom fetch). */
  protected async resolveOpenAIClient(apiKey: string, baseURL: string | undefined): Promise<any> {
    const { default: OpenAI } = await import("openai")
    return new OpenAI({ apiKey, baseURL })
  }

  // ─── Content conversion ─────────────────────────────────────────────────────

  private _convertContentPart(part: ContentPart): any {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text }
      case "image_url":
        return { type: "image_url", image_url: { url: part.image_url.url } }
      case "image_base64":
        return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.base64}` } }
      case "document":
        log.warn(`[llm-client] ${this.providerName}: document content parts are not supported — content will be omitted`)
        return { type: "text", text: `[Document: ${part.fileName || "file"}] (content not supported for this provider)` }
      default:
        return { type: "text", text: JSON.stringify(part) }
    }
  }

  private _convertMessage(msg: LLMMessage): any {
    if (Array.isArray(msg.content)) {
      return { ...msg, content: msg.content.map(p => this._convertContentPart(p)) }
    }
    return msg
  }

  // ─── Main call ──────────────────────────────────────────────────────────────

  async call(options: LLMCallOptions): Promise<LLMResponse> {
    const baseURL = options.baseUrl?.trim() || OPENAI_COMPAT_BASE_URLS[this.providerName] || undefined
    await this.beforeCall(options)

    const apiKey = options.apiKey

    if (!apiKey) {
      throw new Error(`API key missing for provider: ${this.providerName}. Configure it in Settings → Providers.`)
    }

    const client = await this.resolveOpenAIClient(apiKey, baseURL)
    const needsReasoning = this.needsReasoningRoundtrip()

    const sanitized = sanitizeMessages(options.messages)
    const rawMessages = needsReasoning
      ? sanitized
      : sanitized.map(({ reasoning_content: _rc, ...rest }) => rest as typeof sanitized[number])
    const messagesForProvider = rawMessages.map(m => this._convertMessage(m))

    const providerPrefix = new RegExp(`^${this.providerName}\\/`, "i")
    const body: any = {
      model: options.model.replace(providerPrefix, ""),
      messages: messagesForProvider,
      temperature: requiresTemperature1(this.providerName, options.model) ? 1 : (options.temperature ?? 0.7),
    }
    const maxTokens = resolveMaxTokens(options.maxTokens, options.contextWindow)
    if (maxTokens) body.max_tokens = maxTokens
    const profile = getProviderProfile(this.providerName)
    const sendTools = modelSupportsTools(this.providerName, options.model) && !!(options.tools?.length)

    const toolNameMap = new Map<string, string>()
    // Canonical tool names, used by the text fallback to accept a bare JSON tool call.
    const knownToolNames = new Set<string>(options.tools?.map(t => t.function.name) ?? [])

    if (sendTools) {
      const preparedTools = options.tools!.map((t) => {
        const originalName = t.function.name
        const wireName = profile.normalizeToolNames
          ? normalizeToolName(originalName, profile.toolNameReplacement)
          : originalName
        if (wireName !== originalName) toolNameMap.set(wireName, originalName)
        return {
          ...t,
          function: {
            ...t.function,
            name: wireName,
            parameters: normalizeToolSchema(t.function.parameters as Record<string, unknown>, profile),
          },
        }
      })
      body.tools = preparedTools
      body.tool_choice = profile.toolChoiceAuto
      if (profile.disableParallelToolCalls) body.parallel_tool_calls = false

      this.injectToolsIntoPrompt(body, preparedTools)
    }

    log.info(`[llm-client] ${this.providerName}/${body.model} — ${options.messages.length} msgs, ${options.tools?.length ?? 0} tools${sendTools ? "" : " (tools suppressed)"}`)

    if (options.onToken) {
      return this._streamCall(client, body, options, toolNameMap, sendTools, profile, knownToolNames)
    }

    let response
    try {
      response = await client.chat.completions.create(this.modifyRequestBody(body, options), { signal: options.signal })
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status
      const errMsg = (err?.error?.message ?? err?.message ?? "").toLowerCase()

      if (isContextOverflowError(err, errMsg)) {
        log.warn(`[llm-client] ${this.providerName}: context overflow — compacting messages and retrying`)
        const originalCount = body.messages.length
        compactBodyForContextOverflow(body, err)
        log.info(`[llm-client] ${this.providerName}: compacted ${originalCount} msgs → ${body.messages.length} msgs, max_tokens=${body.max_tokens}`)
        response = await client.chat.completions.create(this.modifyRequestBody(body, options), { signal: options.signal })
      } else if (sendTools && profile.retryWithoutToolsOnCodes.includes(status)) {
        log.warn(`[llm-client] ${this.providerName}: tools rejected (HTTP ${status}) — retrying without tools`)
        const bodyNoTools = { ...body }
        delete bodyNoTools.tools
        delete bodyNoTools.tool_choice
        delete bodyNoTools.parallel_tool_calls
        response = await client.chat.completions.create(this.modifyRequestBody(bodyNoTools, options), { signal: options.signal })
      } else {
        throw err
      }
    }

    const choice = response.choices[0]
    const msg = choice.message

    let final_tool_calls: LLMToolCall[] | undefined = (msg.tool_calls as any[])?.map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: toolNameMap.get(tc.function.name) ?? tc.function.name,
        arguments: tc.function.arguments,
      },
    }))

    let final_content = msg.content ?? ""

    if (sendTools && (!final_tool_calls || final_tool_calls.length === 0) && final_content) {
      const extracted = extractToolCallsFromText(final_content, toolNameMap, knownToolNames)
      if (extracted.tool_calls.length > 0) {
        final_tool_calls = extracted.tool_calls
        final_content = extracted.content
      }
    }

    final_tool_calls = ensureToolCallIds(final_tool_calls)

    const result: LLMResponse = {
      content: final_content,
      tool_calls: final_tool_calls,
      reasoning_content: (msg as any).reasoning_content ?? undefined,
      // Tool calls win over finish_reason. Servers that recover calls from text — or
      // that report "stop" alongside native tool_calls, as llama.cpp and LM Studio do
      // for several templates — would otherwise have their calls dropped by the caller.
      stop_reason: resolveStopReason(choice.finish_reason, final_tool_calls),
      usage: response.usage ? {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
      } : undefined,
    }

    return this.afterCall(result, options)
  }

  // ─── Streaming ──────────────────────────────────────────────────────────────

  private async _streamCall(
    client: any,
    body: any,
    options: LLMCallOptions,
    toolNameMap: Map<string, string>,
    sendTools: boolean,
    profile: ReturnType<typeof getProviderProfile>,
    knownToolNames: Set<string>,
  ): Promise<LLMResponse> {
    // llama.cpp and other local servers only report usage when explicitly asked.
    // Without it the loop's token/cost ceilings never see anything to measure.
    const streamBody = { ...this.modifyRequestBody(body, options), stream: true, stream_options: { include_usage: true } }
    let stream
    try {
      stream = await client.chat.completions.create(streamBody, { signal: options.signal })
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status
      const errMsg = (err?.error?.message ?? err?.message ?? "").toLowerCase()

      if (isContextOverflowError(err, errMsg)) {
        log.warn(`[llm-client] ${this.providerName}: context overflow — compacting messages and retrying stream`)
        const originalCount = body.messages.length
        compactBodyForContextOverflow(body, err)
        log.info(`[llm-client] ${this.providerName}: compacted ${originalCount} msgs → ${body.messages.length} msgs, max_tokens=${body.max_tokens}`)
        stream = await client.chat.completions.create({ ...this.modifyRequestBody(body, options), stream: true, stream_options: { include_usage: true } }, { signal: options.signal })
      } else if (sendTools && profile.retryWithoutToolsOnCodes.includes(status)) {
        log.warn(`[llm-client] ${this.providerName}: tools rejected (HTTP ${status}) — retrying stream without tools`)
        const bodyNoTools = { ...body }
        delete bodyNoTools.tools
        delete bodyNoTools.tool_choice
        delete bodyNoTools.parallel_tool_calls
        stream = await client.chat.completions.create({ ...this.modifyRequestBody(bodyNoTools, options), stream: true, stream_options: { include_usage: true } }, { signal: options.signal })
      } else {
        throw err
      }
    }

    let content = ""
    let reasoning_content = ""
    let finish_reason = "stop"
    const toolCallMap: Map<number, { id: string; name: string; arguments: string }> = new Map()
    let input_tokens = 0
    let output_tokens = 0

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0]
      if (!choice) continue

      const delta = choice.delta as any
      if (delta.content) {
        content += delta.content
        options.onToken!(delta.content)
      }
      if (delta.reasoning_content) {
        reasoning_content += delta.reasoning_content
        options.onReasoningToken?.(delta.reasoning_content)
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          // llama.cpp with --jinja frequently omits `index`. Falling back to a shared
          // key would collapse every call of the turn into one entry, concatenating
          // their arguments into unparseable JSON. Start a new slot when a chunk
          // carries a fresh name or id instead, and only then reuse the last one.
          const idx: number = typeof tc.index === "number"
            ? tc.index
            : resolveMissingToolCallIndex(toolCallMap, tc)

          if (!toolCallMap.has(idx)) {
            toolCallMap.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" })
          }
          const entry = toolCallMap.get(idx)!
          if (tc.id) entry.id = tc.id
          if (tc.function?.name) entry.name = tc.function.name
          if (tc.function?.arguments) {
            // Some builds re-emit the complete arguments string on the finalizing
            // chunk. Appending it verbatim would double the JSON.
            entry.arguments = appendToolCallArguments(entry.arguments, tc.function.arguments)
          }
        }
      }
      if (choice.finish_reason) finish_reason = choice.finish_reason

      if (chunk.usage) {
        input_tokens = chunk.usage.prompt_tokens ?? 0
        output_tokens = chunk.usage.completion_tokens ?? 0
      }
    }

    const tool_calls: LLMToolCall[] = [...toolCallMap.values()].map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: toolNameMap.get(tc.name) ?? tc.name,
        arguments: tc.arguments || "{}",
      },
    }))

    let final_tool_calls: LLMToolCall[] | undefined = tool_calls.length ? tool_calls : undefined
    let final_content = content

    if (sendTools && !final_tool_calls && final_content) {
      const extracted = extractToolCallsFromText(final_content, toolNameMap, knownToolNames)
      if (extracted.tool_calls.length > 0) {
        final_tool_calls = extracted.tool_calls
        final_content = extracted.content
      }
    }

    final_tool_calls = ensureToolCallIds(final_tool_calls)

    const result: LLMResponse = {
      content: final_content,
      tool_calls: final_tool_calls,
      reasoning_content: reasoning_content || undefined,
      stop_reason: resolveStopReason(finish_reason, final_tool_calls),
      usage: input_tokens > 0 || output_tokens > 0
        ? { input_tokens, output_tokens }
        : undefined,
    }

    return this.afterCall(result, options)
  }
}

/**
 * Deriva stop_reason dando prioridad a la presencia de tool calls.
 *
 * `finish_reason` no es confiable para decidir si hay trabajo pendiente: llama.cpp y
 * LM Studio devuelven "stop" junto a tool_calls nativos en varias plantillas, y cuando
 * los tool calls se recuperan del texto el finish_reason siempre es "stop". Quien
 * consume esto corta el loop si no ve "tool_calls", así que la señal fuerte manda.
 */
export function resolveStopReason(
  finishReason: string | null | undefined,
  toolCalls: LLMToolCall[] | undefined,
): LLMResponse["stop_reason"] {
  if (toolCalls?.length) return "tool_calls"
  if (finishReason === "tool_calls") return "tool_calls"
  if (finishReason === "length") return "max_tokens"
  return "stop"
}

/**
 * Garantiza que cada tool call lleve un id no vacío.
 *
 * Sin id, el resultado vuelve con `tool_call_id: ""`, que `sanitizeMessages` trata como
 * falsy: se saltea la detección de huérfanos y N llamadas colapsan en una sola entrada
 * del Set de ids. El modelo no puede correlacionar resultados y repite las llamadas.
 */
export function ensureToolCallIds(toolCalls: LLMToolCall[] | undefined): LLMToolCall[] | undefined {
  if (!toolCalls?.length) return toolCalls
  return toolCalls.map(tc => (tc.id ? tc : { ...tc, id: crypto.randomUUID() }))
}

/**
 * Elige el slot de un delta de tool call cuando el servidor no manda `index`.
 *
 * En el protocolo de streaming de OpenAI, `function.name` sólo aparece en el primer
 * chunk de cada llamada: un chunk con nombre, cuando el slot abierto ya tiene uno,
 * es una llamada nueva — incluso si es la misma herramienta. Un id distinto también.
 * Los fragmentos de argumentos sin metadata continúan la última llamada abierta.
 *
 * Se exige además que los argumentos acumulados ya parseen, para tolerar servidores
 * que repiten el nombre en cada chunk: si el JSON está a medio armar, es continuación.
 */
function resolveMissingToolCallIndex(
  toolCallMap: Map<number, { id: string; name: string; arguments: string }>,
  tc: any,
): number {
  if (toolCallMap.size === 0) return 0
  const lastIdx = Math.max(...toolCallMap.keys())
  const last = toolCallMap.get(lastIdx)!
  const startsNewCall =
    (tc.id && last.id && tc.id !== last.id) ||
    (tc.function?.name && last.name && isCompleteJSON(last.arguments))
  return startsNewCall ? lastIdx + 1 : lastIdx
}

function isCompleteJSON(text: string): boolean {
  if (!text.trim()) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Concatena un fragmento de argumentos evitando duplicar el payload completo.
 *
 * Varias builds de llama.cpp reemiten la cadena entera en el chunk final; anexarla
 * produciría `{"a":1}{"a":1}`, que no parsea.
 */
function appendToolCallArguments(current: string, chunk: string): string {
  if (!current) return chunk
  if (chunk === current) return current
  if (chunk.startsWith(current)) return chunk
  return current + chunk
}

/**
 * Extrae tool_calls del texto cuando el modelo falla en generar tool_calls nativos.
 * Soporta formatos comunes de Gemma, Qwen y otros modelos que emiten JSON embebido.
 */
export function extractToolCallsFromText(
  content: string,
  toolNameMap: Map<string, string>,
  knownToolNames?: Set<string>,
): { content: string; tool_calls: LLMToolCall[] } {
  const tool_calls: LLMToolCall[] = []
  let extractedContent = content

  const regexes = [
    /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/g,
    /<function_call>\s*({[\s\S]*?})\s*<\/function_call>/g,
    /```(?:tool_call|json)\s*({[\s\S]*?})\s*```/g,
  ]

  for (const regex of regexes) {
    let match
    while ((match = regex.exec(content)) !== null) {
      try {
        const json = JSON.parse(match[1])
        const calls = Array.isArray(json) ? json : [json]
        for (const call of calls) {
          if (!call) continue
          const fn = call.function || call
          const name = fn.name ?? call.name
          const args = fn.arguments ?? call.arguments ?? call.parameters
          if (!name) continue
          tool_calls.push({
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: toolNameMap.get(name) ?? name,
              arguments: typeof args === "object" ? JSON.stringify(args) : (args || "{}"),
            },
          })
          extractedContent = extractedContent.replace(match[0], "").trim()
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Fallback: bare JSON tool call, accepted only when it names a known tool.
  if (tool_calls.length === 0 && knownToolNames && knownToolNames.size > 0) {
    try {
      const trimmed = content.trim()
      const jsonText = trimmed.replace(/^```(?:json|tool_call)?\s*|\s*```$/g, "").trim()
      const json = JSON.parse(jsonText)
      const calls = Array.isArray(json) ? json : [json]
      for (const call of calls) {
        if (!call) continue
        const fn = call.function || call
        const name = fn.name ?? call.name
        const args = fn.arguments ?? call.arguments ?? call.parameters
        const resolvedName = toolNameMap.get(name) ?? name
        if (name && knownToolNames.has(resolvedName) && (args !== undefined || calls.length === 1)) {
          tool_calls.push({
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: resolvedName,
              arguments: typeof args === "object" ? JSON.stringify(args) : (args || "{}"),
            },
          })
          extractedContent = ""
        }
      }
    } catch {
      // not valid JSON
    }
  }

  return { content: extractedContent, tool_calls }
}
