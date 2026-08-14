/**
 * Regression tests for fine-grained tool_result pruning (Fase 3).
 *
 * Runs before full compaction, at a lower token threshold, so most sessions
 * never hit the heavier structure-changing compaction at all. Mirrors
 * Anthropic's "context editing": trim old tool_result bodies, leave a visible
 * placeholder (never silently drop), keep the most recent results verbatim.
 */

import { describe, expect, test } from "bun:test"
import type { LLMMessage } from "@johpaz/hivecode-core/agent/llm-client"
import { pruneOldToolResults } from "@johpaz/hivecode-code/workers/worker-handler"

const MODEL = "claude-sonnet-4-6" // 200k context window

function toolMsg(content: string): LLMMessage {
  return { role: "tool", content, tool_call_id: "x" }
}

function buildMessages(toolCount: number, contentLen: number): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: "system", content: "you are a coordinator" },
    { role: "user", content: "implement the feature" },
  ]
  for (let i = 0; i < toolCount; i++) {
    messages.push({ role: "assistant", content: `step ${i}`, tool_calls: [] })
    messages.push(toolMsg(`result #${i}: ` + "x".repeat(contentLen)))
  }
  return messages
}

describe("pruneOldToolResults", () => {
  test("leaves messages untouched below the trigger threshold", () => {
    const messages = buildMessages(3, 100)
    const result = pruneOldToolResults(messages, MODEL)
    expect(result).toEqual(messages)
  })

  test("prunes old tool results but keeps the most recent ones verbatim", () => {
    // 200k tokens * 0.6 trigger * 3.5 chars-per-token ≈ 420k chars needed to trip it.
    const messages = buildMessages(60, 9000)
    const result = pruneOldToolResults(messages, MODEL)

    const toolResults = result.filter((m) => m.role === "tool")
    expect(toolResults).toHaveLength(60)

    const prunedCount = toolResults.filter((m) => (m.content as string).startsWith("[pruned:")).length
    expect(prunedCount).toBeGreaterThan(0)

    // The last 6 tool results must remain verbatim (not pruned).
    const lastSix = toolResults.slice(-6)
    for (const m of lastSix) {
      expect((m.content as string).startsWith("[pruned:")).toBe(false)
    }
  })

  test("a pruned placeholder discloses that content was removed, never silently drops it", () => {
    const messages = buildMessages(60, 9000)
    const result = pruneOldToolResults(messages, MODEL)
    const pruned = result.find((m) => m.role === "tool" && (m.content as string).startsWith("[pruned:"))
    expect(pruned).toBeDefined()
    expect(pruned!.content).toContain("pruned")
  })

  test("is idempotent — pruning an already-pruned message set doesn't double-prune", () => {
    const messages = buildMessages(60, 9000)
    const once = pruneOldToolResults(messages, MODEL)
    const twice = pruneOldToolResults(once, MODEL)
    expect(twice).toEqual(once)
  })

  test("non-string tool content (structured) is left alone", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      ...Array.from({ length: 60 }, (_, i) => toolMsg("y".repeat(1000))),
    ]
    // Inject one structured-content tool message near the start.
    messages[3] = { role: "tool", content: [{ type: "text", text: "structured" }] as any, tool_call_id: "x" }
    const result = pruneOldToolResults(messages, MODEL)
    expect(result[3].content).toEqual([{ type: "text", text: "structured" }])
  })
})
