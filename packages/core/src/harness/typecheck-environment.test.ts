import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createAllTools } from "../tools/index.ts"
import { verifyDeterministic } from "./deterministic-checks.ts"

// The tool as the verification gets it.
const checkTypesTool = createAllTools({} as never).find(t => t.name === "check_types")!
const REPO = path.resolve(import.meta.dir, "../../../..")
const made: string[] = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** A TypeScript project; `compiler` links the repository's TypeScript in, as `bun add -d typescript` would. */
function project(code: string, compiler: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typecheck-env-"))
  made.push(dir)
  fs.mkdirSync(path.join(dir, "src"))
  fs.mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true })
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p" }))
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }))
  fs.writeFileSync(path.join(dir, "src/a.ts"), code)
  if (compiler) {
    fs.symlinkSync(path.join(REPO, "node_modules/typescript"), path.join(dir, "node_modules/typescript"))
    fs.symlinkSync("../typescript/bin/tsc", path.join(dir, "node_modules/.bin/tsc"))
  }
  return dir
}

describe("the type check and a missing TypeScript install", () => {
  test("the tool says it could not run, instead of reporting a failure with zero errors", async () => {
    const result: any = await checkTypesTool.execute({ path: project("export const a: number = 1", false) }, {} as never)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("TypeScript no está instalado")
    expect(result.error).toContain("bun add -d typescript")
  })

  test("a project with node_modules but no compiler is not judged on types: nothing to check, not a failure", async () => {
    const verdict = await verifyDeterministic(project("export const a: number = 1", false))
    expect(verdict.ok).toBe(true)
    expect(verdict.checks.map(c => c.name)).not.toContain("tipos")
  })

  test("with the compiler installed a real type error is still a failure", async () => {
    const dir = project('export const a: number = "not a number"', true)
    const result: any = await checkTypesTool.execute({ path: dir }, {} as never)
    expect(result.ok).toBe(true)
    expect(result.result.pass).toBe(false)
    expect(result.result.errors.length).toBeGreaterThan(0)
    const verdict = await verifyDeterministic(dir)
    expect(verdict.ok).toBe(false)
    expect(verdict.checks.find(c => c.name === "tipos")?.status).toBe("failed")
  }, 60000)

  test("with the compiler installed and clean code the check passes", async () => {
    const verdict = await verifyDeterministic(project("export const a: number = 1", true))
    expect(verdict.ok).toBe(true)
    expect(verdict.checks.find(c => c.name === "tipos")?.status).toBe("passed")
  }, 60000)
})
