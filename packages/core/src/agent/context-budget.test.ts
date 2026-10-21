import { afterEach, describe, expect, test } from "bun:test"
import {
  capToolResult, clipMiddle, fitLoopMessages, fitMessagesToBudget, messageBudget, messageTokens, packetSnippetCount,
  projectPacketBudget, toolResultCap,
} from "./context-budget"
import type { LLMMessage } from "./llm-client"

const user = (content: string): LLMMessage => ({ role: "user", content })
const assistant = (content: string, tool_calls?: unknown[]): LLMMessage => ({ role: "assistant", content, ...(tool_calls && { tool_calls }) } as LLMMessage)
const tool = (content: string, id: string): LLMMessage => ({ role: "tool", content, tool_call_id: id } as LLMMessage)
const call = (id: string) => ({ id, type: "function", function: { name: "fs_list", arguments: "{}" } })

describe("tool result cap", () => {
  test("scales with the window but stays between 4k and 16k characters", () => {
    expect(toolResultCap(50_000)).toBe(14_000)
    expect(toolResultCap(8_000)).toBe(4_000)
    expect(toolResultCap(1_000_000)).toBe(16_000)
  })

  test("keeps the start and the end of an oversized result", () => {
    const text = `INICIO${"x".repeat(60_000)}FIN`
    const out = capToolResult(text, 50_000)
    expect(out.length).toBeLessThan(toolResultCap(50_000) + 200)
    expect(out.startsWith("INICIO")).toBe(true)
    expect(out.endsWith("FIN")).toBe(true)
    expect(out).toContain("recortado")
  })

  test("leaves a small result alone", () => {
    expect(capToolResult("ok", 50_000)).toBe("ok")
    expect(clipMiddle("abc", 10, "x")).toBe("abc")
  })
})

describe("fitMessagesToBudget", () => {
  test("drops the oldest turns and opens on a user message", () => {
    const history = [user("a".repeat(4_000)), assistant("b".repeat(4_000)), user("c".repeat(4_000)), assistant("d".repeat(4_000)), user("actual")]
    const fitted = fitMessagesToBudget(history, 2_300, 2)
    expect(fitted[0].role).toBe("user")
    expect(fitted[fitted.length - 1].content).toBe("actual")
    expect(fitted.length).toBeLessThan(history.length)
  })

  test("returns the same array when it already fits", () => {
    const history = [user("hola"), assistant("qué tal")]
    expect(fitMessagesToBudget(history, 10_000)).toBe(history)
  })
})

describe("fitLoopMessages", () => {
  const system: LLMMessage = { role: "system", content: "sistema" }

  test("fits a long tool loop without orphaning a tool result", () => {
    const loop: LLMMessage[] = [system, user("objetivo")]
    for (let i = 0; i < 12; i++) {
      loop.push(assistant("", [call(`c${i}`)]), tool("r".repeat(3_000), `c${i}`))
    }
    const budget = 3_000
    const fit = fitLoopMessages(loop, budget)

    expect(fit.dropped).toBeGreaterThan(0)
    expect(fit.messages[0]).toBe(system)
    expect(fit.messages.some(m => m.role === "user" && String(m.content).startsWith("objetivo"))).toBe(true)
    // every tool message still follows the assistant message that called it
    fit.messages.forEach((m, i) => {
      if (m.role === "tool") {
        let j = i - 1
        while (j >= 0 && fit.messages[j].role === "tool") j--
        expect(fit.messages[j].role).toBe("assistant")
      }
    })
    // the newest exchange survives
    expect((fit.messages[fit.messages.length - 1] as any).tool_call_id).toBe("c11")
  })

  test("tells the model that steps were omitted", () => {
    const loop: LLMMessage[] = [system, user("objetivo")]
    for (let i = 0; i < 8; i++) loop.push(assistant("", [call(`c${i}`)]), tool("r".repeat(3_000), `c${i}`))
    const fit = fitLoopMessages(loop, 3_000)
    expect(String(fit.messages.find(m => m.role === "user")!.content)).toContain("Se omitieron")
  })

  test("clips the biggest result when dropping is not enough", () => {
    const loop: LLMMessage[] = [system, user("objetivo"), assistant("", [call("c0")]), tool("z".repeat(40_000), "c0")]
    const fit = fitLoopMessages(loop, 3_000)
    expect(messageTokens(fit.messages[fit.messages.length - 1])).toBeLessThan(1_000)
  })

  test("does not touch a conversation that already fits", () => {
    const small: LLMMessage[] = [system, user("hola")]
    expect(fitLoopMessages(small, 10_000).messages).toBe(small)
  })
})

describe("messageBudget", () => {
  test("is the window's share minus the tool schemas, never below a quarter", () => {
    expect(messageBudget(50_000, undefined)).toBe(40_000)
    expect(messageBudget(50_000, [{ big: "x".repeat(200_000) }])).toBe(12_500)
  })
})

describe("projectPacketBudget", () => {
  const saved = process.env.HIVE_PRELOAD_MAX_TOKENS
  afterEach(() => {
    if (saved === undefined) delete process.env.HIVE_PRELOAD_MAX_TOKENS
    else process.env.HIVE_PRELOAD_MAX_TOKENS = saved
  })

  test("coordinators keep a map-sized packet", () => {
    expect(projectPacketBudget(131_072, true)).toBe(1_000)
    expect(projectPacketBudget(4_000, true)).toBe(480)
  })

  test("a default-size window keeps the historical 2600-token packet", () => {
    delete process.env.HIVE_PRELOAD_MAX_TOKENS
    expect(projectPacketBudget(undefined, false)).toBe(2_600)
    expect(projectPacketBudget(32_768, false)).toBe(2_600)
  })

  test("large windows preload more, capped at 6000", () => {
    delete process.env.HIVE_PRELOAD_MAX_TOKENS
    expect(projectPacketBudget(64_000, false)).toBe(6_000)
    expect(projectPacketBudget(200_000, false)).toBe(6_000)
  })

  test("HIVE_PRELOAD_MAX_TOKENS lowers the ceiling", () => {
    process.env.HIVE_PRELOAD_MAX_TOKENS = "3000"
    expect(projectPacketBudget(128_000, false)).toBe(3_000)
    expect(projectPacketBudget(32_768, false)).toBe(2_600)
  })

  test("snippet count grows with the budget", () => {
    expect(packetSnippetCount(2_600)).toBe(5)
    expect(packetSnippetCount(4_000)).toBe(6)
    expect(packetSnippetCount(6_000)).toBe(8)
  })
})
