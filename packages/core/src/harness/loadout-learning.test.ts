import { describe, expect, test } from "bun:test"
import { reportLoadouts } from "./loadout-learning"

const run = (id: string, agent: string, loadout?: string[]) => ({
  id, agent_id: agent, context_metrics_json: JSON.stringify(loadout ? { tools: 1200, skills: 800, loadout: { tools: loadout, skills: [] } } : {}),
})

describe("reportLoadouts", () => {
  const runs = [
    run("r1", "scout", ["fs_read", "fs_list", "search_knowledge", "outline"]),
    run("r2", "scout#2", ["fs_read", "fs_list", "search_knowledge", "outline"]),
    run("r3", "builder", ["fs_read", "fs_edit"]),
  ]
  const calls = [
    { run_id: "r1", tool_name: "fs_read" }, { run_id: "r1", tool_name: "fs_read" }, { run_id: "r1", tool_name: "search_knowledge" },
    { run_id: "r2", tool_name: "fs_read" }, { run_id: "r2", tool_name: "outline" },
    { run_id: "r3", tool_name: "fs_edit" },
  ]
  const report = reportLoadouts(runs, calls)
  const scout = report.find(r => r.role === "scout")!

  test("a duplicate counts as its base role", () => {
    expect(report.map(r => r.role)).toEqual(["builder", "scout"])
    expect(scout.runs).toBe(2)
  })

  test("lists what was loaded and never called", () => {
    expect(scout.unused).toEqual(["fs_list"])
    expect(scout.used[0]).toEqual({ tool: "fs_read", runs: 2 })
  })

  test("counts runs that searched for capabilities and the share of reads that hit disk", () => {
    expect(scout.discoveryRuns).toBe(1)
    // fs_read×3 on disk; search_knowledge + outline on the index
    expect(scout.diskShare).toBeCloseTo(3 / 5)
  })

  test("averages the start tokens, and tolerates runs older than the loadout record", () => {
    expect(scout.startTokens).toEqual({ tools: 1200, skills: 800 })
    const old = reportLoadouts([run("x", "scout")], [])[0]
    expect(old.loaded).toEqual([])
    expect(old.startTokens).toBeNull()
    expect(old.diskShare).toBeNull()
  })
})
