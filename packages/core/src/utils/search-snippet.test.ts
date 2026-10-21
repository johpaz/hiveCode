import { describe, expect, test } from "bun:test"
import { buildSnippet, buildSnippetWithRange } from "./search-snippet"

const file = Array.from({ length: 200 }, (_, i) => (i === 119 ? "export function needleTarget() {}" : `const filler${i} = ${i}`)).join("\n")

describe("buildSnippetWithRange", () => {
  test("keeps the same fragment as buildSnippet", () => {
    expect(buildSnippetWithRange(file, "needleTarget").snippet).toBe(buildSnippet(file, "needleTarget"))
  })

  test("reports the 1-based lines the match sits on", () => {
    const { startLine, endLine } = buildSnippetWithRange(file, "needleTarget")
    expect(startLine).toBeLessThanOrEqual(120)
    expect(endLine).toBeGreaterThanOrEqual(120)
  })

  test("without a match it points at the top of the file", () => {
    const { startLine } = buildSnippetWithRange(file, "zzzzzz")
    expect(startLine).toBe(1)
  })
})
