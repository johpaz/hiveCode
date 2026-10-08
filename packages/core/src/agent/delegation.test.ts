import { describe, expect, test } from "bun:test"
import {
  buildWorkerBrief,
  checkAcceptance,
  delegationThreadId,
  interpretCheckResult,
  parseAcceptance,
  summarizeAcceptance,
} from "./delegation.ts"
import type { Tool } from "../tools/types.ts"

const tool = (name: string, result: unknown): Tool => ({
  name, description: name, parameters: { type: "object", properties: {} }, execute: async () => result as object,
})

describe("delegation acceptance", () => {
  test("defaults to one 'objective' criterion built from the task", () => {
    expect(parseAcceptance(undefined, "haz X")).toEqual([{ id: "objective", description: "haz X" }])
    expect(parseAcceptance([{ nope: 1 }], "haz X")).toEqual([{ id: "objective", description: "haz X" }])
  })

  test("keeps well-formed criteria, naming the ones without id", () => {
    expect(parseAcceptance([{ description: "A" }, { id: "b", description: "B", checkTool: "t" }], "x")).toEqual([
      { id: "c1", description: "A" },
      { id: "b", description: "B", checkTool: "t" },
    ])
  })

  test("the worker brief carries every criterion", () => {
    const brief = buildWorkerBrief("haz X", [{ id: "a", description: "A" }, { id: "b", description: "B" }])
    expect(brief).toContain("haz X")
    expect(brief).toContain("- [a] A")
    expect(brief).toContain("- [b] B")
  })

  test("interprets check results strictly", () => {
    expect(interpretCheckResult({ met: true, reason: "ok" })).toEqual({ met: true, reason: "ok" })
    expect(interpretCheckResult("false").met).toBe(false)
    expect(interpretCheckResult('{"met":true}').met).toBe(true)
    expect(interpretCheckResult({ done: true }).met).toBe(false)
  })

  test("decides criteria with a checkTool deterministically and leaves the rest to the coordinator", async () => {
    const results = await checkAcceptance(
      [
        { id: "tests", description: "tests pass", checkTool: "ok_tool" },
        { id: "broken", description: "build ok", checkTool: "bad_tool" },
        { id: "style", description: "reads well" },
        { id: "ghost", description: "missing tool", checkTool: "nope" },
      ],
      "handoff text",
      [tool("ok_tool", { met: true, reason: "green" }), tool("bad_tool", { met: false, reason: "red" })],
    )
    expect(results.map(r => [r.id, r.met])).toEqual([["tests", true], ["broken", false], ["style", null], ["ghost", null]])
    expect(results[2]!.evidence).toBe("handoff text")
    expect(summarizeAcceptance(results)).toBe(false)
    expect(summarizeAcceptance(results.filter(r => r.met !== false))).toBeNull()
    expect(summarizeAcceptance(results.filter(r => r.met === true))).toBe(true)
  })

  test("the thread is stable so a revision resumes the same worker", () => {
    expect(delegationThreadId("7", "builder")).toBe("task-7-builder")
  })
})
