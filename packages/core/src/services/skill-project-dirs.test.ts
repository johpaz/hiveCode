import { afterAll, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SkillLoader, getProjectSkillsDirs } from "@johpaz/hivecode-skills"
import { closeHiveDb } from "../storage/hivedb"
import { ensureHiveDb } from "../storage/bootstrap"
import { col } from "../storage/hive"
import type { SkillDoc } from "../storage/collections"
import { searchCapabilities } from "../agent/capability-search"
import { syncSkillsToIndex } from "../agent/skill-selector"
import { syncSkillCatalog } from "./skill-catalog"

const previous = process.env.HIVE_DB_PATH
beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "skill-proj-")), "db")
  await ensureHiveDb()
})
afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

test("a skill that `npx skills add` put in ./.agents/skills reaches the database and is searchable", async () => {
  const project = mkdtempSync(path.join(tmpdir(), "skill-project-"))
  expect(getProjectSkillsDirs(project)).toEqual([])
  mkdirSync(path.join(project, ".agents/skills/pdf-wrangler"), { recursive: true })
  writeFileSync(path.join(project, ".agents/skills/pdf-wrangler/SKILL.md"), "---\nname: pdf-wrangler\ndescription: Split and merge PDF files\n---\n# PDF wrangler\nUse qpdf to split pages.")
  mkdirSync(path.join(project, ".claude/skills/other-one"), { recursive: true })
  writeFileSync(path.join(project, ".claude/skills/other-one/SKILL.md"), "---\nname: other-one\ndescription: Another\n---\nbody")

  expect(getProjectSkillsDirs(project).map(d => path.relative(project, d))).toEqual([".agents/skills", ".claude/skills"])
  const loader = new SkillLoader({ workspacePath: project, skills: { extraDirs: getProjectSkillsDirs(project) } })
  await syncSkillCatalog(loader.loadAllSkills())
  await syncSkillsToIndex()

  const row = (await (await col<SkillDoc>("skills")).get("pdf-wrangler"))!.doc
  expect(row.active).toBe(true)
  expect(row.body).toContain("qpdf")
  expect(row.source_path).toContain(".agents/skills/pdf-wrangler")
  expect((await searchCapabilities("split merge pdf", { types: ["skill"], k: 10 })).some(h => h.rawId === "pdf-wrangler")).toBe(true)
  expect(await (await col<SkillDoc>("skills")).get("other-one")).toBeDefined()
})
