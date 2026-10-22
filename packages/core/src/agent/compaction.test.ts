import { describe, expect, test } from "bun:test"
import { clearOldToolResults } from "./compaction"

const long = "x".repeat(3_000)
const turn = (id: string, name: string) => [
  { role: "assistant", content: "", tool_calls: [{ id, function: { name } }] },
  { role: "tool", content: long, tool_call_id: id },
]

describe("clearOldToolResults", () => {
  const messages: any[] = [
    { role: "user", content: "go" },
    ...turn("a", "fs_read"), ...turn("b", "fs_read"), ...turn("c", "task_delegate"), ...turn("d", "task_delegate"),
    ...turn("e", "fs_read"), ...turn("f", "fs_read"), ...turn("g", "fs_read"), ...turn("h", "fs_read"),
  ]
  const out = clearOldToolResults(messages, 2)
  const result = (id: string) => out.find((m: any) => m.tool_call_id === id)!.content as string

  test("old file reads are clipped", () => {
    expect(result("a").length).toBeLessThan(long.length)
  })

  test("delegation results stay whole, even the older of two", () => {
    expect(result("c")).toBe(long)
    expect(result("d")).toBe(long)
  })
})
