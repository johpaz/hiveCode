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

  test("groups by route and specialty, flags thin samples, and lists what had to be searched for", () => {
    const withMeta = (id: string, status: string, extra: object) => ({
      id, agent_id: "scout", status,
      context_metrics_json: JSON.stringify({ loadout: { tools: ["fs_read"], skills: [], route: "scoped", specialty: "backend", ...extra } }),
    })
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => withMeta(`ok${i}`, "completed", i < 4 ? { discovered: { tools: ["git_diff"], skills: ["code_review"] } } : {})),
      withMeta("bad", "failed", { discovered: { tools: ["web_fetch"], skills: [] } }),
      { ...withMeta("other", "completed", { route: "feature", specialty: "-" }) },
    ]
    const [role] = reportLoadouts(rows, [])
    expect(role.runs).toBe(11)
    expect(role.groups).toEqual([
      { route: "scoped", specialty: "backend", runs: 10, enough: true },
      { route: "feature", specialty: "-", runs: 1, enough: false },
    ])
    expect(role.discovered).toEqual([
      { name: "code_review", kind: "skill", runs: 4 },
      { name: "git_diff", kind: "tool", runs: 4 },
    ])
  })
})
