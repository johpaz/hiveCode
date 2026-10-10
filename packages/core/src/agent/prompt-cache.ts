/**
 * Prompt-cache boundary inside the system prompt.
 *
 * Providers that cache by prefix (Anthropic explicitly, OpenAI-compatible
 * servers implicitly) only reuse the bytes that are identical from the start of
 * the request. The compiler therefore writes everything that is stable for a run
 * first and everything that changes per turn (scratchpad, summary, retrieved
 * memory) after this marker. The marker never reaches a model: Anthropic splits
 * on it to place `cache_control`, every other provider gets it stripped.
 */

export const PROMPT_VOLATILE_MARKER = "\n\n<!--hive:volatile-->\n\n"

export interface SplitSystemPrompt {
  /** Identical across the turns of a run — the cacheable prefix. */
  stable: string
  /** Changes per turn; empty when the prompt carries no marker. */
  volatile: string
}

export function splitSystemPrompt(text: string): SplitSystemPrompt {
  const at = text.indexOf(PROMPT_VOLATILE_MARKER)
  if (at === -1) return { stable: text, volatile: "" }
  return {
    stable: text.slice(0, at),
    volatile: text.slice(at + PROMPT_VOLATILE_MARKER.length),
  }
}

/** The prompt as a model should read it: same text, boundary removed. */
export function stripVolatileMarker(text: string): string {
  const { stable, volatile } = splitSystemPrompt(text)
  return volatile ? `${stable}\n\n${volatile}` : stable
}
