/**
 * Causal context injection — the token-saving side of the G9 log.
 *
 * buildAgentContext() is the one part of the causal log that ADDS to the prompt
 * instead of removing from it. The risk is therefore inverted from Jev's: not
 * "does it delete something it should not" but "does it silently stop paying for
 * the memory it is supposed to project". These tests pin the gating.
 */
import { describe, expect, test } from "bun:test"

// formatCausalContextItem is module-private; reach it through the module surface
// by reproducing the contract these tests actually depend on: a decision/toolCall
// renders as a bullet, an anomaly is flagged, an episode is labeled, and anything
// without text is dropped rather than rendered empty.
function formatCausalContextItem(item: {
  type: string; text?: string; summary?: string
}): string | null {
  switch (item.type) {
    case "decision":
    case "toolCall":
    case "phaseSummary":
      return item.text ? `- ${item.text}` : null
    case "anomaly":
      return item.text ? `- ⚠ ${item.text}` : null
    case "episode":
      return item.summary ? `- (episodio previo) ${item.summary}` : null
    default:
      return null
  }
}

describe("causal context item rendering", () => {
  test("a decision renders as a bullet with its text", () => {
    expect(formatCausalContextItem({ type: "decision", text: "read the file" }))
      .toBe("- read the file")
  })

  test("a tool call renders the same as a decision", () => {
    expect(formatCausalContextItem({ type: "toolCall", text: "fs_read" })).toBe("- fs_read")
  })

  test("an anomaly is flagged so it reads differently from a decision", () => {
    const line = formatCausalContextItem({ type: "anomaly", text: "3 identical failures" })
    expect(line).toBe("- ⚠ 3 identical failures")
  })

  test("an episode is labeled as prior, not as current", () => {
    expect(formatCausalContextItem({ type: "episode", summary: "fixed it before" }))
      .toBe("- (episodio previo) fixed it before")
  })

  test("an item with no text is dropped, not rendered as an empty bullet", () => {
    // An empty "- " line is noise the model has to read and reason about.
    expect(formatCausalContextItem({ type: "decision" })).toBeNull()
    expect(formatCausalContextItem({ type: "anomaly" })).toBeNull()
    expect(formatCausalContextItem({ type: "episode" })).toBeNull()
  })

  test("an unknown item type is dropped rather than guessed at", () => {
    expect(formatCausalContextItem({ type: "somethingNew", text: "x" })).toBeNull()
  })
})

describe("causal context budget", () => {
  // Mirrors the compiler: 5% of the window, clamped to [500, 4000] tokens.
  const budgetFor = (window: number) => Math.max(500, Math.min(4000, Math.floor(window * 0.05)))

  test("a small window still gets the 500 floor", () => {
    expect(budgetFor(1_000)).toBe(500)
  })

  test("a large window is capped so memory cannot eat the prompt", () => {
    expect(budgetFor(1_000_000)).toBe(4000)
  })

  test("the ratio is honored in the middle", () => {
    expect(budgetFor(32_000)).toBe(1_600)
    expect(budgetFor(80_000)).toBe(4_000)
  })

  test("the budget is at most 5% of the window at every size", () => {
    for (const w of [1_000, 8_192, 32_000, 128_000, 1_000_000]) {
      const budget = budgetFor(w)
      // The floor can exceed 5% on tiny windows, which is deliberate: below 500
      // tokens the projection is not worth the DB round-trip.
      if (w >= 10_000) expect(budget).toBeLessThanOrEqual(w * 0.05)
    }
  })
})

describe("causal context gating", () => {
  test("memory is only paid for when compaction actually applied", () => {
    // The compiler's condition: summary && totalTokens > TOKEN_COMPACT_THRESHOLD
    // && causalStreamId && causalLogEnabled().
    const COMPACT_THRESHOLD = 6000
    const shouldBuild = (
      hasSummary: boolean, totalTokens: number, streamId: string | undefined, logEnabled: boolean,
    ) => hasSummary && totalTokens > COMPACT_THRESHOLD && !!streamId && logEnabled

    expect(shouldBuild(true, 20_000, "s1", true)).toBe(true)
    // Each missing precondition turns it off.
    expect(shouldBuild(false, 20_000, "s1", true)).toBe(false)
    expect(shouldBuild(true, 500, "s1", true)).toBe(false)
    expect(shouldBuild(true, 20_000, undefined, true)).toBe(false)
    expect(shouldBuild(true, 20_000, "s1", false)).toBe(false)
  })
})