import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { col } from "../../packages/core/src/storage/hive"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { ensureHiveDb } from "../../packages/core/src/storage/bootstrap"
import { ensureCoreAgentProfiles } from "../../packages/core/src/agent/agent-profiles"
import { ensureProject, projectIdentity } from "../../packages/core/src/agent/project-identity"
import { areasNamedBy, describeFindings, findingsFor, freshnessOf, reusableFinding, saveFinding, recentScoutFindings, FINDING_TTL_MS } from "../../packages/core/src/agent/findings"
import { buildContextPacket, resolveProjectScope } from "../../packages/core/src/agent/project-context"
import { reconcileCodeIndex } from "../../packages/code/src/agent/code-indexer"
import { taskDelegateTool } from "../../packages/core/src/tools/agents/index"
import type { CodeFindingDoc, CodeSessionDoc } from "../../packages/core/src/storage/collections"

const previous = process.env.HIVE_DB_PATH
let root: string
let workspace: string
let project: ReturnType<typeof projectIdentity>

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" })
const reindex = () => reconcileCodeIndex(project.id, project.root)

/** What a scout leaves behind when it runs: tool calls under its run id. */
async function fakeRun(runId: string, reads: string[]) {
  const toolRuns = await col<any>("toolRuns")
  for (const [i, file] of reads.entries()) {
    await toolRuns.put(`${runId}:${i}`, { id: `${runId}:${i}`, run_id: runId, task_id: "t", tool_name: i % 2 ? "outline" : "fs_read", call_id: String(i), args_json: JSON.stringify({ path: file }), result_json: null, status: "completed", read_only: true, mutates_workspace: false, mutates_db: false, started_at: 1, completed_at: 1, duration_ms: 1, error: null }, { expectedVersion: 0 })
  }
}
const save = (over: Partial<Parameters<typeof saveFinding>[0]> = {}) => saveFinding({
  projectId: project.id, sessionId: "s1", agentId: "scout", runId: "run-1", workspace: project.root,
  objective: "Audita SOLO packages/core/src/harness. NO explores otros paquetes.", summary: "El harness decide la ruta por tamaño. Riesgo: umbral fijo.", partial: false, ...over,
})

beforeEach(async () => {
  closeHiveDb()
  root = mkdtempSync(path.join(tmpdir(), "hive-findings-"))
  process.env.HIVE_DB_PATH = path.join(root, "db")
  await ensureHiveDb()
  await ensureCoreAgentProfiles()
  workspace = path.join(root, "repo")
  mkdirSync(path.join(workspace, "packages/core/src/harness"), { recursive: true })
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "findings-app" }))
  writeFileSync(path.join(workspace, "packages/core/src/harness/route.ts"), "export function route() { return 1 }\n")
  writeFileSync(path.join(workspace, "packages/core/src/harness/weight.ts"), "export const weight = 2\n")
  git(workspace, "init", "-q", "-b", "main"); git(workspace, "add", "-A"); git(workspace, "commit", "-q", "-m", "init")
  project = projectIdentity(workspace)
  await ensureProject(workspace)
  await (await col<CodeSessionDoc>("codeSessions")).put("s1", { id: "s1", project_path: workspace, status: "active", created_at: "2026-10-10", last_active: "2026-10-10" })
  await reindex()
  await fakeRun("run-1", ["packages/core/src/harness/route.ts", "packages/core/src/harness/weight.ts"])
})
afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

describe("saving", () => {
  test("a scout's report is kept with the files it read and their hashes", async () => {
    const finding = (await save())!
    expect(finding.role).toBe("scout")
    expect(JSON.parse(finding.areas_json)).toEqual(["packages/core/src/harness"])
    expect(Object.keys(JSON.parse(finding.files_json)).sort()).toEqual(["packages/core/src/harness/route.ts", "packages/core/src/harness/weight.ts"])
    expect(finding.status).toBe("completed")
  })

  test("an instance counts as its role; a partial run is kept as partial", async () => {
    const finding = (await save({ agentId: "scout#2", partial: true }))!
    expect(finding.role).toBe("scout")
    expect(finding.status).toBe("partial")
  })

  test("only readers are kept, and only with something to validate them against", async () => {
    expect(await save({ agentId: "builder" })).toBeNull()
    expect(await save({ summary: "   " })).toBeNull()
    await fakeRun("run-empty", [])
    expect(await save({ runId: "run-empty" })).toBeNull()
    await fakeRun("run-unindexed", ["not/in/the/index.ts"])
    expect(await save({ runId: "run-unindexed" })).toBeNull()
  })
})

describe("freshness", () => {
  test("is current while the files are as they were, and names what changed after", async () => {
    const finding = (await save())!
    expect((await freshnessOf(finding)).fresh).toBe(true)

    const file = path.join(workspace, "packages/core/src/harness/route.ts")
    writeFileSync(file, "export function route() { return 2 }\n")
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    await reindex()
    const stale = await freshnessOf(finding)
    expect(stale.fresh).toBe(false)
    expect(stale.changed).toEqual(["packages/core/src/harness/route.ts"])
  })

  test("a deleted file makes it stale, and so does age", async () => {
    const finding = (await save())!
    expect((await freshnessOf(finding, Date.now() + FINDING_TTL_MS + 1000)).old).toBe(true)
    expect((await freshnessOf(finding, Date.now() + FINDING_TTL_MS + 1000)).fresh).toBe(false)
    const { rmSync } = await import("node:fs")
    rmSync(path.join(workspace, "packages/core/src/harness/weight.ts"))
    await reindex()
    expect((await freshnessOf(finding)).missing).toEqual(["packages/core/src/harness/weight.ts"])
  })
})

describe("finding and reusing", () => {
  test("areas are read from the wording of a task", () => {
    expect(areasNamedBy("Revisa packages/core/src/harness y ./tests/context/, luego dime.")).toEqual(["packages/core/src/harness", "tests/context"])
    expect(areasNamedBy("revisa el arnés")).toEqual([])
  })

  test("a finding speaks to an area inside it, around it, or one of the files it read", async () => {
    await save()
    for (const area of ["packages/core/src/harness", "packages/core/src/harness/route.ts", "packages/core/src", "packages/core"])
      expect((await findingsFor(project.id, [area])).length).toBe(1)
    expect(await findingsFor(project.id, ["packages/cli"])).toHaveLength(0)
    expect(await findingsFor(project.id, [])).toHaveLength(0)
  })

  test("it is reused only for the same role, fully covered, complete and current", async () => {
    await save()
    const ask = "Audita packages/core/src/harness a fondo"
    expect((await reusableFinding(project.id, "scout", ask))?.finding.summary).toContain("umbral fijo")
    expect(await reusableFinding(project.id, "planner", ask)).toBeNull()
    expect(await reusableFinding(project.id, "scout", "Audita packages/core/src/harness y packages/cli/src")).toBeNull()
    expect(await reusableFinding(project.id, "scout", "revisa el proyecto")).toBeNull()
  })

  test("a partial finding is never reused", async () => {
    await save({ partial: true })
    expect(await reusableFinding(project.id, "scout", "Audita packages/core/src/harness")).toBeNull()
  })

  test("describeFindings says the state and, when asked, carries the report", async () => {
    await save()
    const matches = await findingsFor(project.id, ["packages/core/src/harness"])
    expect(describeFindings(matches)).toContain("vigente")
    expect(describeFindings(matches, { withSummary: true })).toContain("umbral fijo")
  })
})

describe("where it shows up", () => {
  test("task_delegate hands back the saved report instead of running the worker", async () => {
    await save()
    const config = { configurable: { code_session_id: "s1", workspace } }
    const reused = await taskDelegateTool.execute({ worker_id: "scout", task_description: "Audita packages/core/src/harness" }, config) as any
    expect(reused).toMatchObject({ ok: true, reused: true })
    expect(reused.result).toContain("Hallazgo guardado reutilizado")
    expect(reused.result).toContain("umbral fijo")
  })

  test("a changed file means the worker is not skipped", async () => {
    const finding = (await save())!
    const file = path.join(workspace, "packages/core/src/harness/route.ts")
    writeFileSync(file, "export function route() { return 3 }\n")
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    await reindex()
    expect((await freshnessOf(finding)).fresh).toBe(false)
    expect(await reusableFinding(project.id, "scout", "Audita packages/core/src/harness")).toBeNull()
  })

  test("the packet of a worker carries the report on its areas; the coordinator's lists what is covered", async () => {
    await save()
    const scope = (await resolveProjectScope({ sessionId: "s1", workspace }))!
    const worker = await buildContextPacket(scope, { query: "Audita packages/core/src/harness", tokenBudget: 3_000 })
    expect(worker.context).toContain("Earlier findings on the areas named by the task")
    expect(worker.context).toContain("umbral fijo")
    const coordinator = await buildContextPacket(scope, { summaryOnly: true, tokenBudget: 3_000 })
    expect(coordinator.context).toContain("Saved findings")
    expect(coordinator.context).toContain("vigente")
    expect(coordinator.context).not.toContain("umbral fijo")
  })
})

describe("planner packet", () => {
  test("a planner gets the scout reports whatever areas its task names; other roles only those on named areas", async () => {
    await save({ summary: "REPORTE-DEL-SCOUT: route.ts decide por tamaño (route.ts:1)." })
    expect((await recentScoutFindings(project.id, "s1")).length).toBe(1)

    const scope = await resolveProjectScope({ sessionId: "s1", workspace: project.root })
    const objective = "revisa el proyecto y planea mejoras"
    const planner = await buildContextPacket(scope, { query: objective, forRole: "planner", tokenBudget: 6_000 })
    const builder = await buildContextPacket(scope, { query: objective, forRole: "builder", tokenBudget: 6_000 })
    expect(planner.context).toContain("REPORTE-DEL-SCOUT")
    expect(planner.context).toContain("Scout reports for this project")
    expect(builder.context).not.toContain("REPORTE-DEL-SCOUT")
  })
})

