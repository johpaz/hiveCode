import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb"
import { ensureHiveDb } from "../storage/bootstrap"
import { col } from "../storage/hive"
import type { SkillDoc } from "../storage/collections"
import { syncSkillsToIndex } from "./skill-selector"
import { CORE_AGENT_DEFINITIONS } from "./agent-profiles"
import { computeLoadout, type LoadoutInput } from "./loadout"
import { compactNames } from "./context-compiler"
import { toolTriggers, toolsTriggeredBy } from "./tool-metadata"

const previous = process.env.HIVE_DB_PATH
beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "loadout-")), "db")
  await ensureHiveDb()
})
afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

const envelope = (role: keyof typeof CORE_AGENT_DEFINITIONS) => new Set(CORE_AGENT_DEFINITIONS[role].tools)
const load = (over: Partial<LoadoutInput> & { role: string }) => computeLoadout({
  envelope: envelope(over.role as any), taskText: "Revisa packages/core/src/harness y dime los riesgos.", indexed: true, ...over,
})
const names = (tools: Set<string>) => [...tools].sort()

describe("computeLoadout · the core of each role", () => {
  test("a scout starts with the index tools and the two ways to read, not with git, ast or tree walking", async () => {
    const { tools, skills } = await load({ role: "scout" })
    for (const name of ["search_knowledge", "get_project_context", "outline", "find_symbol", "dependents", "tests_for", "fs_read", "search_in_files"]) expect(tools.has(name)).toBe(true)
    for (const name of ["git_status", "git_diff", "git_log", "find_imports", "parse_ast", "fs_list", "fs_glob", "web_search", "web_fetch"]) expect(tools.has(name)).toBe(false)
    expect(skills.map(s => s.name)).toEqual(expect.arrayContaining(["busqueda_hivedb", "file_read_and_summarize"]))
    expect(skills.map(s => s.name)).not.toContain("code_analysis")
  })

  test("without an index a reader walks the tree", async () => {
    const { tools } = await load({ role: "scout", indexed: false })
    expect(tools.has("fs_list") && tools.has("fs_glob")).toBe(true)
  })

  test("the planner adds the Spec Kit tools it writes with", async () => {
    const { tools } = await load({ role: "planner" })
    for (const name of ["speckit_init", "speckit_artifact_write", "speckit_validate", "outline"]) expect(tools.has(name)).toBe(true)
    expect(tools.has("web_search")).toBe(false)
  })

  test("a builder carries the tools that edit and check; a verifier no browser unless the task is about one", async () => {
    const builder = await load({ role: "builder", taskText: "añade un campo al modelo" })
    for (const name of ["fs_edit", "fs_write", "fs_read", "shell_executor", "code_test", "check_types"]) expect(builder.tools.has(name)).toBe(true)
    expect(builder.tools.has("spawn_agent")).toBe(false)
    const verifier = await load({ role: "verifier", taskText: "verifica que los tests pasan" })
    expect([...verifier.tools].some(name => name.startsWith("browser_"))).toBe(false)
  })
})

describe("computeLoadout · what the database adds", () => {
  test("the wording of the task brings the tools it calls for", async () => {
    const { tools, reasons } = await load({ role: "verifier", taskText: "Prueba la interfaz en el navegador y revisa la captura" })
    expect(tools.has("browser_navigate") && tools.has("browser_screenshot")).toBe(true)
    expect(reasons.browser_navigate).toBe("disparador en la tarea")
  })

  test("a specialty brings its own", async () => {
    const { tools } = await load({ role: "builder", specialtyId: "backend", taskText: "implementa el endpoint" })
    expect(tools.has("code_build") && tools.has("run_script")).toBe(true)
  })

  test("a skill ranked for the task brings its tools, and a skill written for another role is muted", async () => {
    const skills = await col<SkillDoc>("skills")
    const base = { version: "1.0.0", author: "t", icon: "x", category: "custom", permissions: "[]", dependencies: "[]", active: true, version_num: 1, created_at: 1, updated_at: 1 }
    await skills.put("zebra-for-builder", { ...base, id: "zebra-for-builder", name: "zebra-for-builder", description: "Zebra migrations", tools: "run_script", triggers: "zebra migración", preferred_agents: JSON.stringify(["builder"]), body: "Run zebra migrations." }, { expectedVersion: 0 })
    await syncSkillsToIndex()
    const builder = await load({ role: "builder", taskText: "haz la zebra migración" })
    expect(builder.skills.map(s => s.name)).toContain("zebra-for-builder")
    expect(builder.tools.has("run_script")).toBe(true)
    // For a verifier the skill is muted but a strong trigger still reaches it; for a role with no use for its tools it is dropped.
    const scout = await load({ role: "scout", taskText: "haz la zebra migración" })
    expect(scout.skills.map(s => s.name)).not.toContain("zebra-for-builder")
  })

  test("skills ranked for the task respect their token budget", async () => {
    const { skills } = await load({ role: "builder", taskText: "refactoriza, prueba, revisa, migra, commit, rama, git, tdd" })
    const ranked = skills.filter(s => !["busqueda_hivedb", "test_driven_development"].includes(s.name))
    expect(ranked.length).toBeLessThanOrEqual(3)
  })
})

describe("computeLoadout · the coordinator by route", () => {
  const bee = (route?: string) => load({ role: "bee", route, taskText: "haz algo" })

  test("a reading or planning request is delegated entirely: no writing or reading tools", async () => {
    const { tools } = await bee("conversation")
    for (const name of ["task_delegate", "task_revise", "task_status", "search_knowledge", "get_project_context", "outline"]) expect(tools.has(name)).toBe(true)
    for (const name of ["fs_edit", "fs_write", "fs_read", "fs_list", "shell_executor", "code_test", "spawn_agent"]) expect(tools.has(name)).toBe(false)
  })

  test("a direct change is made by BEE, so it carries the writing tools", async () => {
    const { tools } = await bee("scoped")
    for (const name of ["fs_edit", "fs_write", "fs_read", "shell_executor", "check_types", "code_test"]) expect(tools.has(name)).toBe(true)
  })

  test("a feature is delegated: Spec Kit and enough reading to judge, no writing", async () => {
    const { tools } = await bee("feature")
    for (const name of ["speckit_artifact_read", "speckit_validate", "speckit_converge", "fs_read"]) expect(tools.has(name)).toBe(true)
    expect(tools.has("fs_write") || tools.has("fs_edit")).toBe(false)
  })

  test("with no route (no harness task) it keeps everything it had", async () => {
    const { tools } = await bee(undefined)
    for (const name of ["fs_edit", "fs_write", "fs_read", "fs_list", "speckit_validate", "spawn_agent"]) expect(tools.has(name)).toBe(true)
  })
})

describe("computeLoadout · limits", () => {
  test("never wider than the envelope", async () => {
    const small = new Set(["fs_read", "search_knowledge", "browser_navigate"])
    const { tools, manifest } = await computeLoadout({ role: "verifier", envelope: small, taskText: "prueba la interfaz del navegador y haz un commit", indexed: true })
    expect(names(tools).every(name => small.has(name))).toBe(true)
    expect(manifest).toEqual([...small].filter(name => !tools.has(name)).sort())
  })

  test("the manifest names what the role may use and did not get", async () => {
    const full = envelope("verifier")
    const { tools, manifest } = await load({ role: "verifier", taskText: "verifica los tests" })
    expect(manifest.length + tools.size).toBe(full.size)
    expect(manifest).toContain("browser_navigate")
    expect(manifest).not.toContain("fs_read")
  })

  test("an unknown role still gets search_knowledge and what the task calls for", async () => {
    const { tools } = await computeLoadout({ role: "custom", envelope: new Set(["search_knowledge", "fs_read", "web_search"]), taskText: "busca en internet", indexed: true })
    expect(names(tools)).toEqual(["search_knowledge", "web_search"])
  })
})

describe("tool triggers and compact names", () => {
  test("a family shares its triggers; plain tools have none", () => {
    expect(toolTriggers("browser_click")).toContain("navegador")
    expect(toolTriggers("fs_read")).toEqual([])
    expect(toolsTriggeredBy("haz un commit", ["git_commit", "fs_read", "browser_click"])).toEqual(["git_commit"])
  })

  test("a family of several collapses, a few names stay", () => {
    const names = ["browser_a", "browser_b", "browser_c", "browser_d", "git_status", "git_diff", "web_search"]
    expect(compactNames(names)).toBe("browser_* (4), git_status, git_diff, web_search")
  })
})
