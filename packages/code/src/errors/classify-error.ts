import { HiveError, LLMError, NetworkError, SystemError, TimeoutError } from "./hive-errors.ts"

export function classifyError(err: unknown): HiveError {
  if (err instanceof HiveError) return err

  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()

  if (
    msg.includes("timed out after") ||
    msg.includes("timeout") && (msg.includes("worker") || msg.includes("phase"))
  ) {
    return new TimeoutError(
      err instanceof Error ? err.message : String(err),
      { originalError: err }
    )
  }

  if (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("aborterror") ||
    msg.includes("network") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("connection refused")
  ) {
    return new NetworkError(
      err instanceof Error ? err.message : String(err),
      { originalError: err }
    )
  }

  if (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("overloaded") ||
    msg.includes("too many requests") ||
    msg.includes("llm error") ||
    msg.includes("api error") && (msg.includes("anthropic") || msg.includes("openai") || msg.includes("gemini"))
  ) {
    return new LLMError(
      err instanceof Error ? err.message : String(err),
      { originalError: err }
    )
  }

  if (
    msg.includes("worker crashed") ||
    msg.includes("worker is already running") ||
    msg.includes("out of memory") ||
    msg.includes("segmentation fault")
  ) {
    return new SystemError(
      err instanceof Error ? err.message : String(err),
      { originalError: err }
    )
  }

  return new SystemError(
    err instanceof Error ? err.message : String(err),
    { originalError: err }
  )
}
