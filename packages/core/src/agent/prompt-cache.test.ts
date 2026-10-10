import { describe, expect, test } from "bun:test"
import { PROMPT_VOLATILE_MARKER, splitSystemPrompt, stripVolatileMarker } from "./prompt-cache"

describe("prompt cache boundary", () => {
  test("splits a prompt into stable prefix and volatile tail", () => {
    const { stable, volatile } = splitSystemPrompt(`IDENTITY${PROMPT_VOLATILE_MARKER}# SCRATCHPAD\nnote`)
    expect(stable).toBe("IDENTITY")
    expect(volatile).toBe("# SCRATCHPAD\nnote")
  })

  test("a prompt without the marker is all stable", () => {
    expect(splitSystemPrompt("plain")).toEqual({ stable: "plain", volatile: "" })
  })

  test("stripping keeps both halves and removes the marker", () => {
    const text = stripVolatileMarker(`A${PROMPT_VOLATILE_MARKER}B`)
    expect(text).toBe("A\n\nB")
    expect(text).not.toContain("hive:volatile")
  })

  test("stripping a prompt with an empty tail drops the marker cleanly", () => {
    expect(stripVolatileMarker(`A${PROMPT_VOLATILE_MARKER}`)).toBe("A")
  })
})
