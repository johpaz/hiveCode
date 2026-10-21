import { beforeEach, afterEach, afterAll, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, symlinkSync, statSync, utimesSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { col } from "../../packages/core/src/storage/hive"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { ensureHiveDb } from "../../packages/core/src/storage/bootstrap"
import { ensureCoreAgentProfiles } from "../../packages/core/src/agent/agent-profiles"
import { buildFullIndex, reconcileCodeIndex, updateFileIndex } from "../../packages/code/src/agent/code-indexer"
import { buildContextPacket, resolveProjectScope, resolveContextReferences } from "../../packages/core/src/agent/project-context"
import { getProjectContextTool, searchKnowledgeTool } from "../../packages/core/src/tools/core"
import { compileContext } from "../../packages/core/src/agent/context-compiler"
import { childCapabilities, runEphemeralAgent } from "../../packages/core/src/agent/ephemeral-agents"
import { getSwarmUsage } from "../../packages/core/src/agent/swarm-usage"
import { withExecutionSlot } from "../../packages/core/src/agent/execution-limits"
import type { AgentDoc, CodeSessionDoc, CodeGraphDoc, TaskDoc } from "../../packages/core/src/storage/collections"

const previous = process.env.HIVE_DB_PATH
let root: string
let scope: {sessionId: string; workspace: string}
beforeEach(async () => {
  closeHiveDb()
  root = mkdtempSync(path.join(tmpdir(), "hive-context-"))
  process.env.HIVE_DB_PATH = path.join(root, "db")
  await ensureHiveDb()
  await ensureCoreAgentProfiles()
  const workspace = path.join(root, "project")
  mkdirSync(path.join(workspace, "src"), {recursive: true})
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({name: "context-fixture", scripts: {test: "cargo test"}}))
  writeFileSync(path.join(workspace, "src/lib.rs"), "pub struct Office {}\npub fn render_office() {\n  println!(\"RUST_PROJECT_A\");\n}\n")
  writeFileSync(path.join(workspace, "schema.sql"), "CREATE TABLE agents (id TEXT PRIMARY KEY);")
  writeFileSync(path.join(workspace, "README.md"), "# Context fixture")
  await (await col<CodeSessionDoc>("codeSessions")).put("a", {id: "a", project_path: workspace, status: "active", created_at: "2026-10-10", last_active: "2026-10-10"})
  scope = {sessionId: "a", workspace}
  await buildFullIndex("a", workspace)
})
afterEach(async () => { await Bun.sleep(10) })
afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

test("indexes Rust symbols and returns fresh, bounded ranges instead of a full project", async () => {
  const graph = (await (await col<CodeGraphDoc>("codeGraph")).get(`a:${path.join(scope.workspace, "src/lib.rs")}`))!.doc
  expect(JSON.parse(graph.symbols_json!)).toEqual(expect.arrayContaining([expect.objectContaining({name: "render_office", startLine: 2})]))
  expect(graph.relations_complete).toBe(false)
  const packet = await buildContextPacket(scope, {query: "render_office", tokenBudget: 900})
  expect(packet.context).toContain("RUST_PROJECT_A")
  expect(packet.estimatedTokens).toBeLessThanOrEqual(900)
  expect(packet.references.some(ref => ref.filePath === "src/lib.rs")).toBe(true)
})

test("does not choose the most recently active project or accept foreign references", async () => {
  const other = path.join(root, "other")
  mkdirSync(other)
  writeFileSync(path.join(other, "private.ts"), "export const PRIVATE_PROJECT_B = 1")
  await (await col<CodeSessionDoc>("codeSessions")).put("b", {id: "b", project_path: other, status: "active", created_at: "2026-10-11", last_active: "2026-10-11"})
  await buildFullIndex("b", other)
  await expect(resolveProjectScope({})).rejects.toThrow("Ambiguous")
  await expect(resolveProjectScope({sessionId: "b", workspace: scope.workspace})).rejects.toThrow("do not match")
  const packet = await buildContextPacket(scope, {query: "PRIVATE_PROJECT_B"})
  expect(packet.context).not.toContain("PRIVATE_PROJECT_B =")
  const otherPacket = await buildContextPacket({sessionId: "b", workspace: other}, {paths: ["private.ts"]})
  await expect(resolveContextReferences(scope, otherPacket.references)).rejects.toThrow("another session")
  const response = await getProjectContextTool.execute({}, {configurable: {code_session_id: "a", workspace: scope.workspace}}) as any
  expect(response.scope.sessionId).toBe("a")
})

test("invalidates packets on uncommitted edits, same-mtime edits and deletion", async () => {
  const source = path.join(scope.workspace, "src/lib.rs")
  const packet = await buildContextPacket(scope, {paths: ["src/lib.rs"]})
  expect((await buildContextPacket(scope, {paths: ["src/lib.rs"]})).cached).toBe(true)
  const before = statSync(source)
  writeFileSync(source, "pub fn render_office() { println!(\"NEW_SOURCE\"); }")
  utimesSync(source, before.atime, before.mtime)
  await expect(resolveContextReferences(scope, packet.references)).rejects.toThrow("Stale")
  const fresh = await buildContextPacket(scope, {paths: ["src/lib.rs"]})
  expect(fresh.context).toContain("NEW_SOURCE")
  expect(fresh.version).not.toBe(packet.version)
  // reconcile compara mtime y no hashea el repo: la edición con mtime intacto ya
  // la cubrió el hash del paquete; aquí, un cambio con mtime nuevo.
  writeFileSync(source, "pub fn render_office() { println!(\"MTIME_SOURCE\"); }")
  const later = new Date(Date.now() + 5_000)
  utimesSync(source, later, later)
  expect((await reconcileCodeIndex("a", scope.workspace)).reindexed).toBeGreaterThan(0)
  unlinkSync(source)
  await updateFileIndex("a", source, scope.workspace)
  expect((await buildContextPacket(scope, {paths: ["src/lib.rs"]})).omitted.join(" ")).toContain("src/lib.rs")
})

test("excludes ignored directories, secrets and escaping symlinks", async () => {
  mkdirSync(path.join(scope.workspace, "node_modules"))
  writeFileSync(path.join(scope.workspace, "node_modules/private.rs"), "fn SECRET() {}")
  writeFileSync(path.join(scope.workspace, ".env.json"), '{"SECRET": "fixture"}')
  writeFileSync(path.join(root, "outside.rs"), "fn OUTSIDE() {}")
  symlinkSync(path.join(root, "outside.rs"), path.join(scope.workspace, "escape.rs"))
  await reconcileCodeIndex("a", scope.workspace)
  const packet = await buildContextPacket(scope, {paths: ["escape.rs", ".env.json"]})
  expect(packet.context).not.toContain("OUTSIDE")
  expect(packet.context).not.toContain("SECRET")
  expect(packet.omitted).toHaveLength(2)
})

test("compact discovery returns references, without injecting skill bodies", async () => {
  const result = await searchKnowledgeTool.execute({query: "render_office", type: "code", mode: "compact", session_id: "a", limit: 2}) as any
  expect(result.code[0].reference.hash).toBeTruthy()
  // A code hit without its snippet and lines only sends the reader to fs_read: compact keeps both, shorter.
  expect(result.code[0].snippet).toContain("render_office")
  expect(result.code[0].lines).toMatch(/^\d+-\d+$/)
})

test("compiler automatically supplies a task packet and a factory specialty", async () => {
  const compiled = await compileContext({agentId: "builder", threadId: "task-a", userMessage: "Mejorar la interfaz TUI render_office",
    codeSessionId: "a", workspace: scope.workspace, isolated: true, contextPaths: ["src/lib.rs"]})
  expect(compiled.systemPrompt).toContain("RUST_PROJECT_A")
  expect(compiled.systemPrompt).toContain("ESPECIALIDAD frontend")
  expect(compiled.tools.some(tool => tool.function.name === "spawn_agent")).toBe(true)
  expect(compiled.contextMetrics!.project).toBeGreaterThan(0)
})

test("children keep parent permissions, metadata and full durable evidence", async () => {
  const parent = (await (await col<AgentDoc>("agents")).get("scout"))!.doc
  expect(() => childCapabilities(parent, {tools: ["fs_write"]})).toThrow("outside parent")
  const result = await runEphemeralAgent({purpose: "Investigar render_office", context: "", tools: ["fs_read"], skills: []},
    {configurable: {agent_id: "scout", code_session_id: "a", workspace: scope.workspace}}, async opts => {
      const child = (await (await col<AgentDoc>("agents")).get(opts.agentId))!.doc
      expect(child.permission_profile).toBe("read_only")
      expect(child.parent_id).toBe("scout")
      expect(child.ephemeral).toBe(true)
      expect(JSON.parse(child.tools_json!)).toEqual(["fs_read"])
      return "Evidencia verificable: " + "detalle ".repeat(500)
    }) as any
  expect(result.ok).toBe(true)
  expect(result.result.length).toBeLessThan(2600)
  expect(await (await col<AgentDoc>("agents")).get(result.agentId)).toBeUndefined()
  expect((await (await col<TaskDoc>("tasks")).get(result.task_id))!.doc.result!.length).toBeGreaterThan(3000)
})

test("timeout cancels the child before removing its executor", async () => {
  const result = await runEphemeralAgent({purpose: "Investigar", timeoutMs: 100, tools: ["fs_read"], skills: []},
    {configurable: {agent_id: "scout", code_session_id: "a", workspace: scope.workspace}}, async opts => {
      await new Promise((_resolve, reject) => opts.signal!.addEventListener("abort", () => reject(opts.signal!.reason), {once: true}))
      return "unreachable"
    }) as any
  expect(result.status).toBe("timeout")
  expect(await (await col<AgentDoc>("agents")).get(result.agentId)).toBeUndefined()
  expect((await (await col<TaskDoc>("tasks")).get(result.task_id))!.doc.status).toBe("failed")
})

test("bounds active execution to four and serializes workspace mutations", async () => {
  let active = 0, max = 0
  await Promise.all(Array.from({length: 9}, () => withExecutionSlot("session", undefined, async () => {
    active++; max = Math.max(max, active); await Bun.sleep(5); active--
  })))
  expect(max).toBe(4)
  active = 0; max = 0
  await Promise.all(Array.from({length: 5}, () => withExecutionSlot("session", undefined, async () => {
    active++; max = Math.max(max, active); await Bun.sleep(5); active--
  }, scope.workspace)))
  expect(max).toBe(1)
})


test("serializes mutations across sessions sharing a workspace and cancels queued work", async () => {
  let active = 0, max = 0
  await Promise.all(["one", "two", "three"].map(session => withExecutionSlot(session, undefined, async () => {
    active++; max = Math.max(max, active); await Bun.sleep(5); active--
  }, scope.workspace)))
  expect(max).toBe(1)
  let unblock!: () => void
  const first = withExecutionSlot("one", undefined, () => new Promise<void>(resolve => {unblock = resolve}), scope.workspace)
  await Bun.sleep(1)
  const cancel = new AbortController()
  const queued = withExecutionSlot("two", cancel.signal, async () => {throw new Error("must not execute")}, scope.workspace)
  cancel.abort(new Error("cancelled queue"))
  await expect(queued).rejects.toThrow("cancelled queue")
  unblock(); await first
  expect(await withExecutionSlot("two", undefined, async () => "released", scope.workspace)).toBe("released")
})

test("expands context for mandatory project rules without silently truncating them", async () => {
  const rules = "Preserve project contracts and review evidence.\n".repeat(100) + "END_OF_MANDATORY_RULES"
  writeFileSync(path.join(scope.workspace, "AGENTS.md"), rules)
  const ctx = await compileContext({agentId: "bee", threadId: "rules", userMessage: "Coordinate", isolated: true, codeSessionId: "a", workspace: scope.workspace, contextWindow: 32768})
  expect(ctx.systemPrompt).toContain(rules)
  expect(ctx.contextMetrics!.total).toBeLessThan(32768 * .8)
})

test("aggregates actual usage across durable descendants after temporary agents retire", async () => {
  const runs = await col<import("../../packages/core/src/storage/collections").AgentRunDoc>("agentRuns")
  const base = {task_id: "usage-task", thread_id: "usage-task", session_id: "a", agent_id: "retired", kind: "worker" as const, objective: "Evidence", status: "completed" as const, turn: 1, max_turns: 2, checkpoint_json: null, blocker: null, next_action: null, lease_owner: "", lease_expires_at: 0, created_at: 1, updated_at: 1, completed_at: 1}
  await runs.put("root", {...base, id: "root", input_tokens: 100, output_tokens: 10, cost_usd: .01, context_metrics_json: JSON.stringify({estimated_input_tokens: 90})})
  await runs.put("child", {...base, id: "child", parent_run_id: "root", input_tokens: 200, output_tokens: 20, cost_usd: .02, context_metrics_json: JSON.stringify({estimated_input_tokens: 180})})
  expect(await getSwarmUsage("root")).toEqual({runs: 2, inputTokens: 300, outputTokens: 30, costUsd: .03, estimatedInputTokens: 270})
})

test("factory agents survive curator cleanup and enabled archived profiles recover", async () => {
  const {runCurator} = await import("../../packages/core/src/agent/curator")
  const agents = await col<AgentDoc>("agents")
  const builder = (await agents.get("builder"))!.doc
  await agents.put("unused-custom-worker", {...builder, id: "unused-custom-worker", name: "Unused", agent_type: undefined, created_at: Date.now() - 30 * 86400000})
  await runCurator()
  expect((await agents.get("unused-custom-worker"))!.doc.status).toBe("archived")
  for (const id of ["bee", "planner", "scout", "builder", "verifier", "spider"]) expect((await agents.get(id))!.doc.status).not.toBe("archived")
  await agents.put("builder", {...(await agents.get("builder"))!.doc, status: "archived", enabled: true})
  await agents.put("spider", {...(await agents.get("spider"))!.doc, status: "archived", enabled: false})
  await ensureCoreAgentProfiles()
  expect((await agents.get("builder"))!.doc.status).toBe("idle")
  expect((await agents.get("spider"))!.doc).toMatchObject({status: "archived", enabled: false})
})

test("office roster includes BEE and canonical factory ids with their actual tools", async () => {
  const {describeSwarmCapabilities} = await import("../../packages/core/src/agent/swarm-capabilities")
  const {listEnabledCoordinatorNames} = await import("../../packages/cli/src/commands-code/provider-store")
  expect(await listEnabledCoordinatorNames()).toEqual(["bee", "planner", "scout", "builder", "verifier", "spider"])
  const roster = await describeSwarmCapabilities(null, {includeSpecialists: true, includeCoordinator: true})
  expect(roster.specialists.map(agent => agent.id).sort()).toEqual(["bee", "builder", "planner", "scout", "spider", "verifier"])
  expect(roster.specialists.find(agent => agent.id === "builder")?.tools).toContain("fs_read")
  expect(roster.specialists.find(agent => agent.id === "builder")?.tools).toContain("fs_write")
  expect(roster.specialists.find(agent => agent.id === "spider")?.tools).toContain("browser_screenshot")
})
