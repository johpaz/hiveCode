import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describeProjectFacts, readProjectFacts, type ProjectFacts } from "./task-weight.ts"
import { checksFor } from "./deterministic-checks.ts"

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  files: 18, modules: 3, hasTests: true, hasTypescript: true, hasDependencies: true,
  hasPackageJson: true, scripts: ["test", "build"], packageManager: "bun", ...over,
})

describe("describeProjectFacts", () => {
  test("says how the project runs and what the harness will check by itself", () => {
    const text = describeProjectFacts(facts(), ["pruebas", "tipos", "build"])
    expect(text).toContain("gestor de paquetes: bun")
    expect(text).toContain("bun run test, bun run build")
    expect(text).toContain("el harness ejecuta solo (pruebas, tipos, build)")
  })

  test("says so when there is nothing the harness can run", () => {
    expect(describeProjectFacts(facts({ hasTests: false, scripts: [] }), [])).toContain("no hay nada que el harness pueda ejecutar solo")
  })

  test("is empty for an empty workspace", () => {
    expect(describeProjectFacts(undefined)).toBe("")
    expect(describeProjectFacts(facts({ files: 0, hasPackageJson: false }))).toBe("")
  })
})

describe("checksFor", () => {
  test("only the checks that apply to the project", () => {
    expect(checksFor(facts()).map(c => c.label)).toEqual(["pruebas", "tipos", "build"])
    expect(checksFor(facts({ hasTests: false, scripts: [] })).map(c => c.label)).toEqual(["tipos"])
    // Types without installed dependencies would measure the environment, not the code.
    expect(checksFor(facts({ hasDependencies: false })).map(c => c.label)).toEqual(["pruebas", "build"])
  })
})

describe("readProjectFacts", () => {
  let root: string
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "project-facts-"))
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    fs.writeFileSync(path.join(root, "bun.lock"), "")
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  test("detects the package manager from the lockfile", () => {
    const read = readProjectFacts(root)
    expect(read.packageManager).toBe("bun")
    expect(read.scripts).toEqual(["test"])
  })
})
