import { describe, expect, test } from "bun:test"
import { classifyRead, readMix } from "./read-mix"

describe("readMix", () => {
  test("classifies the tools that read the project", () => {
    expect(classifyRead("fs_read")).toBe("disk")
    expect(classifyRead("search_in_files")).toBe("disk")
    expect(classifyRead("search_knowledge")).toBe("index")
    expect(classifyRead("get_project_context")).toBe("index")
    expect(classifyRead("fs_write")).toBe("other")
  })

  test("splits calls per agent and sums the disk characters", () => {
    const runs = [{ id: "r1", agent_id: "scout" }, { id: "r2", agent_id: "scout#2" }]
    const tools = [
      { run_id: "r1", tool_name: "fs_read", result_json: "x".repeat(100) },
      { run_id: "r1", tool_name: "search_knowledge", result_json: "y" },
      { run_id: "r2", tool_name: "fs_list", result_json: "z".repeat(50) },
      { run_id: "r2", tool_name: "fs_write", result_json: "w" },
    ]
    const { total, byAgent } = readMix(tools, runs)
    expect(total).toEqual({ disk: 2, index: 1, diskChars: 150 })
    expect(byAgent["scout"]).toEqual({ disk: 1, index: 1, diskChars: 100 })
    expect(byAgent["scout#2"]).toEqual({ disk: 1, index: 0, diskChars: 50 })
  })

  test("a call from an unknown run is still counted", () => {
    expect(readMix([{ run_id: "gone", tool_name: "fs_read" }], []).byAgent["unknown"]?.disk).toBe(1)
  })
})

import { DISK_READ_NUDGE_AFTER, diskReadNudge } from "./read-mix"

describe("diskReadNudge", () => {
  test("a scout hears about the index after several disk reads, then again every few", () => {
    const hits: number[] = []
    for (let i = 1; i <= 14; i++) if (diskReadNudge("run-s", "scout", "fs_read")) hits.push(i)
    expect(hits).toEqual([DISK_READ_NUDGE_AFTER, DISK_READ_NUDGE_AFTER + 4, DISK_READ_NUDGE_AFTER + 8])
  })

  test("index calls, writers and other tools never trigger it", () => {
    for (let i = 0; i < 20; i++) {
      expect(diskReadNudge("run-i", "scout", "search_knowledge")).toBeUndefined()
      expect(diskReadNudge("run-b", "builder", "fs_read")).toBeUndefined()
      expect(diskReadNudge("run-b", undefined, "fs_read")).toBeUndefined()
    }
  })
})
