/**
 * A model connection that stops sending is dead, not slow. Without a guard the SDKs wait their own limit (OpenAI: ten minutes
 * per request) and the agent stands still. After `between` ms with no data the request is aborted; if nothing had arrived yet
 * it is sent again (twice at most), and if the answer was already under way the error reaches the loop, because replaying
 * would duplicate text.
 *
 * This bounds the silence of one connection, not how long or how much an agent works.
 */
import { logger } from "../../utils/logger"

const log = logger.child("llm-client")

/** Silence after which a streaming connection counts as dead; HIVECODE_LLM_IDLE_MS overrides it. */
export function llmIdleMs(): { between: number; first: number } {
  const raw = Number(process.env.HIVECODE_LLM_IDLE_MS)
  const set = Number.isFinite(raw) && raw >= 1000
  const between = set ? raw : 120_000
  // The first data may take long when the model reasons without streaming it, so it gets a wider window.
  return { between, first: set ? raw : 300_000 }
}

/** The platform's own network timeout (fetch's `TimeoutError`): the same silence as ours, reported by someone else. */
const isNetworkTimeout = (err: unknown): boolean =>
  (err as { name?: string })?.name === "TimeoutError" || /operation timed out/i.test(String((err as { message?: string })?.message ?? ""))

export interface Heartbeat {
  /** The request was accepted but no data has come yet. */
  open(): void
  /** Data arrived (a chunk of the answer, of its reasoning or of a tool call). */
  data(): void
}

export async function runWithIdleGuard<T>(
  provider: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal, beat: Heartbeat) => Promise<T>,
): Promise<T> {
  const idle = llmIdleMs()
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason)
    if (signal?.aborted) forward()
    else signal?.addEventListener("abort", forward, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let received = false
    let timedOut = false
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, received ? idle.between : idle.first)
    }
    arm()
    try {
      const result = await run(controller.signal, { open: arm, data: () => { received = true; arm() } })
      // The SDKs end the stream quietly when it is aborted midway: a cut answer must not pass for a finished one.
      if (timedOut) throw new Error("idle")
      return result
    } catch (err) {
      // A timeout raised by the network layer before any data counts as the same silence, and is retried the same way.
      if (!timedOut && !(isNetworkTimeout(err) && !received)) throw err
      timedOut = true
      const seconds = Math.round((received ? idle.between : idle.first) / 1000)
      log.warn(`[llm-client] ${provider}: no data for ${seconds}s${received ? " mid-answer" : ""}`)
      if (received || attempt >= 2) throw new Error(`El modelo (${provider}) dejó de enviar datos durante ${seconds} s${received ? " a mitad de la respuesta" : ""}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", forward)
    }
  }
}
