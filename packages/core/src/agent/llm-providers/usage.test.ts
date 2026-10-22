import { describe, expect, test } from "bun:test"
import { cachedTokens } from "./usage"

describe("cachedTokens", () => {
  test("reads each provider's name for it", () => {
    expect(cachedTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } })).toBe(80)
    expect(cachedTokens({ prompt_tokens: 100, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 })).toBe(64)
    expect(cachedTokens({ input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 })).toBe(900)
  })

  test("a reported zero is a zero; a provider that says nothing is undefined", () => {
    expect(cachedTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } })).toBe(0)
    expect(cachedTokens({ prompt_tokens: 100 })).toBeUndefined()
    expect(cachedTokens(undefined)).toBeUndefined()
    expect(cachedTokens("x")).toBeUndefined()
  })
})
