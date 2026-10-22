import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb"
import { ensureHiveDb } from "../storage/bootstrap"
import { col } from "../storage/hive"
import type { SkillDoc } from "../storage/collections"
import { searchCapabilities } from "../agent/capability-search"
import { addSkillsFromSource, discoverGithubSkills, parseSkillSource, selectSkills, toSkillDoc } from "./skill-install"

const previous = process.env.HIVE_DB_PATH
beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "skill-install-")), "db")
  await ensureHiveDb()
})
afterAll(() => {
  closeHiveDb()
  if (previous === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previous
})

const FIND_SKILLS = `---
name: demo-finder
description: Helps users discover and install agent skills when they ask how do I do X.
---

# Demo Finder

Use this skill to search the skills ecosystem for a capability the user needs.
`

/** A fake GitHub: one tree listing and the raw files. */
function fakeGithub(files: Record<string, string>, extra: Array<{ path: string; type: string }> = []) {
  const calls: string[] = []
  const impl = (async (input: any) => {
    const url = String(input)
    calls.push(url)
    if (url.includes("/git/trees/")) {
      const tree = [...Object.keys(files).map(p => ({ path: p, type: "blob" })), ...extra]
      return new Response(JSON.stringify({ tree }), { status: 200 })
    }
    const raw = decodeURIComponent(url.split("/HEAD/")[1] ?? url.split(/\/(?:main|v1)\//)[1] ?? "")
    return files[raw] ? new Response(files[raw], { status: 200 }) : new Response("nope", { status: 404 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe("parseSkillSource", () => {
  const none = () => false
  test("reads GitHub URLs, with and without a branch and folder", () => {
    expect(parseSkillSource("https://github.com/vercel-labs/skills", none)).toEqual({ kind: "github", owner: "vercel-labs", repo: "skills", ref: undefined, subpath: undefined })
    expect(parseSkillSource("https://github.com/o/r/tree/dev/skills/x", none)).toMatchObject({ owner: "o", repo: "r", ref: "dev", subpath: "skills/x" })
    expect(parseSkillSource("git@github.com:o/r.git", none)).toMatchObject({ kind: "github", owner: "o", repo: "r" })
  })
  test("owner/repo is a repository unless such a path exists", () => {
    expect(parseSkillSource("vercel-labs/skills", none).kind).toBe("github")
    expect(parseSkillSource("vercel-labs/skills", () => true).kind).toBe("local")
    expect(parseSkillSource("./skills/x", none).kind).toBe("local")
  })
})

describe("discoverGithubSkills", () => {
  test("lists SKILL.md files and leaves hidden folders out", async () => {
    const { impl } = fakeGithub({ "skills/demo-finder/SKILL.md": FIND_SKILLS, ".vc/automations/skills/triage/SKILL.md": FIND_SKILLS, "README.md": "x" })
    const found = await discoverGithubSkills({ kind: "github", owner: "o", repo: "r" }, { fetch: impl, env: {} })
    expect(found.map(f => f.dir)).toEqual(["skills/demo-finder"])
  })

  test("explains a missing repository and a rate limit", async () => {
    const status = (code: number) => (async () => new Response("", { status: code })) as unknown as typeof fetch
    await expect(discoverGithubSkills({ kind: "github", owner: "o", repo: "r" }, { fetch: status(404), env: {} })).rejects.toThrow("No encontré o/r")
    await expect(discoverGithubSkills({ kind: "github", owner: "o", repo: "r" }, { fetch: status(403), env: {} })).rejects.toThrow("GITHUB_TOKEN")
  })
})

describe("toSkillDoc", () => {
  test("keeps the frontmatter fields and drops the frontmatter from the body", () => {
    const parsed = toSkillDoc({ dir: "skills/demo-finder", content: FIND_SKILLS, origin: "https://x/SKILL.md" }, "vercel-labs") as any
    expect(parsed.doc).toMatchObject({ id: "demo-finder", name: "demo-finder", author: "vercel-labs", active: true, catalog_managed: false })
    expect(parsed.doc.description).toContain("discover and install")
    expect(parsed.doc.body.trimStart().startsWith("# Demo Finder")).toBe(true)
  })

  test("rejects an invalid name and an empty body", () => {
    expect((toSkillDoc({ dir: "x", content: "---\nname: bad name!\n---\nbody", origin: "o" }, "a") as any).error).toContain("no válido")
    expect((toSkillDoc({ dir: "x", content: "---\nname: ok\n---\n", origin: "o" }, "a") as any).error).toContain("no tiene contenido")
  })

  test("a skill with no frontmatter name takes its first heading, then its folder", () => {
    expect((toSkillDoc({ dir: "pdf-tools", content: "# My PDF Skill\nDo pdfs", origin: "o" }, "a") as any).doc.id).toBe("my_pdf_skill")
    expect((toSkillDoc({ dir: "pdf-tools", content: "Do pdfs", origin: "o" }, "a") as any).doc.id).toBe("pdf-tools")
  })
})

describe("selectSkills", () => {
  const found = [
    { dir: "skills/a", content: "---\nname: alpha\n---\nx", origin: "o" },
    { dir: "skills/b", content: "---\nname: beta\n---\nx", origin: "o" },
  ]
  test("picks by frontmatter name or folder, reports what is missing", () => {
    expect(selectSkills(found, ["beta", "gamma"])).toMatchObject({ missing: ["gamma"], available: ["alpha", "beta"] })
    expect(selectSkills(found, ["a"]).chosen).toHaveLength(1)
  })
  test("with no name it only decides for a single skill", () => {
    expect(selectSkills(found, []).chosen).toHaveLength(0)
    expect(selectSkills(found.slice(0, 1), []).chosen).toHaveLength(1)
  })
})

describe("addSkillsFromSource", () => {
  test("installs demo-finder from GitHub into the database, active and searchable", async () => {
    const { impl } = fakeGithub({ "skills/demo-finder/SKILL.md": FIND_SKILLS })
    const result = await addSkillsFromSource("https://github.com/vercel-labs/skills", { skills: ["demo-finder"] }, { fetch: impl, env: {} })
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0]).toMatchObject({ name: "demo-finder", status: "installed", verified: { stored: true, active: true, searchable: true } })
    const row = (await (await col<SkillDoc>("skills")).get("demo-finder"))!.doc
    expect(row.source_path).toContain("vercel-labs/skills")
    expect(row.catalog_managed).toBe(false)
    const hits = await searchCapabilities("discover install skills", { types: ["skill"], k: 10 })
    expect(hits.some(h => h.rawId === "demo-finder")).toBe(true)
  })

  test("running it again updates instead of duplicating", async () => {
    const { impl } = fakeGithub({ "skills/demo-finder/SKILL.md": FIND_SKILLS })
    await addSkillsFromSource("o/r", { skills: ["demo-finder"] }, { fetch: impl, env: {} })
    const again = await addSkillsFromSource("o/r", { skills: ["demo-finder"] }, { fetch: impl, env: {} })
    expect(again.outcomes[0].status).toBe("updated")
    expect((await (await col<SkillDoc>("skills")).scan()).filter(e => e.doc.id === "demo-finder")).toHaveLength(1)
  })

  test("--list installs nothing, and several skills without a choice ask for one", async () => {
    const { impl } = fakeGithub({ "skills/a/SKILL.md": "---\nname: alpha\n---\nbody", "skills/b/SKILL.md": "---\nname: beta\n---\nbody" })
    const listed = await addSkillsFromSource("o/r", { list: true }, { fetch: impl, env: {} })
    expect(listed.available).toEqual(["alpha", "beta"])
    expect(await (await col<SkillDoc>("skills")).get("alpha")).toBeUndefined()
    const asked = await addSkillsFromSource("o/r", {}, { fetch: impl, env: {} })
    expect(asked.needsChoice).toBe(true)
    expect(asked.outcomes).toHaveLength(0)
  })

  test("a name that is not in the repository comes back as missing", async () => {
    const { impl } = fakeGithub({ "skills/demo-finder/SKILL.md": FIND_SKILLS })
    const result = await addSkillsFromSource("o/r", { skills: ["nope"] }, { fetch: impl, env: {} })
    expect(result.missing).toEqual(["nope"])
    expect(result.outcomes).toHaveLength(0)
  })

  test("a skill the catalog already loads is left alone and reported as loaded, not overwritten", async () => {
    const skills = await col<SkillDoc>("skills")
    const managed = (await skills.scan()).map(e => e.doc).find(d => d.catalog_managed && d.active)
    expect(managed).toBeDefined()
    const { impl } = fakeGithub({ [`skills/${managed!.name}/SKILL.md`]: `---\nname: ${managed!.name}\n---\nhijack` })
    const result = await addSkillsFromSource("o/r", { skills: [managed!.name] }, { fetch: impl, env: {} })
    expect(result.outcomes[0].status).toBe("catalog")
    expect(result.outcomes[0].verified?.stored).toBe(true)
    expect((await skills.get(managed!.name))!.doc.body).not.toBe("hijack")
  })

  test("installs from a local folder too", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skill-local-"))
    mkdirSync(path.join(dir, "mine"))
    writeFileSync(path.join(dir, "mine/SKILL.md"), "---\nname: mine\ndescription: local one\n---\nDo the local thing")
    const result = await addSkillsFromSource(dir, { skills: ["mine"] })
    expect(result.outcomes[0]).toMatchObject({ name: "mine", status: "installed", verified: { stored: true, active: true } })
  })
})

import { describeSkillInstall, parseSkillAddArgs } from "./skill-install"

describe("parseSkillAddArgs", () => {
  test("the source, repeated --skill, -s and --skill=, and --list", () => {
    expect(parseSkillAddArgs(["https://github.com/o/r", "--skill", "a", "-s", "b", "--skill=c"])).toEqual({ source: "https://github.com/o/r", skills: ["a", "b", "c"], list: false })
    expect(parseSkillAddArgs(["o/r", "--list"])).toEqual({ source: "o/r", skills: [], list: true })
    expect(parseSkillAddArgs(["--skill", "--list", "o/r"])).toEqual({ source: "o/r", skills: [], list: true })
  })
})

describe("describeSkillInstall", () => {
  test("says what was checked, and warns about trusting the source", async () => {
    const { impl } = fakeGithub({ "skills/demo-finder/SKILL.md": FIND_SKILLS })
    const result = await addSkillsFromSource("o/r", { skills: ["demo-finder"] }, { fetch: impl, env: {} })
    const text = describeSkillInstall(result, false)
    expect(text).toContain("✓ demo-finder (instalada)")
    expect(text).toContain("encontrable: sí")
    expect(text).toContain("fuentes en las que confíes")
  })

  test("a listing names the skills and how to pick one", async () => {
    const { impl } = fakeGithub({ "skills/a/SKILL.md": "---\nname: alpha\n---\nx", "skills/b/SKILL.md": "---\nname: beta\n---\nx" })
    const text = describeSkillInstall(await addSkillsFromSource("o/r", { list: true }, { fetch: impl, env: {} }), true)
    expect(text).toContain("· alpha")
    expect(text).toContain("--skill <nombre>")
  })
})
