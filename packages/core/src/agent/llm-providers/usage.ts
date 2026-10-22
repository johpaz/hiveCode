/**
 * Tokens of a request the provider served from its prompt cache, whatever it calls them:
 * OpenAI-style `prompt_tokens_details.cached_tokens`, DeepSeek's `prompt_cache_hit_tokens`,
 * Anthropic's `cache_read_input_tokens`. Undefined when the provider says nothing, which is not the same as 0:
 * "no cache" and "cache not reported" lead to opposite conclusions about what a long context costs.
 */
export function cachedTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined
  const u = usage as Record<string, any>
  const candidates = [u.prompt_tokens_details?.cached_tokens, u.prompt_cache_hit_tokens, u.cache_read_input_tokens, u.cached_tokens]
  for (const value of candidates) if (typeof value === "number" && Number.isFinite(value)) return value
  return undefined
}
