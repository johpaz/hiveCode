import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAllTools } from "../tools/index.ts"
import { describeProjectFacts, readProjectFacts } from "./task-weight.ts"
import { planChecks, verifyDeterministic } from "./deterministic-checks.ts"

const made: string[] = []
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "eco-verify-"))
  made.push(dir)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file.split("/").slice(0, -1).join("/") || "."), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}
const PY_OK = { "app/__init__.py": "", "app/main.py": "def f():\n    return 1\n", "tests/__init__.py": "", "tests/test_main.py": "import unittest\nfrom app.main import f\n\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(f(), 1)\n" }
const hasPython = !!Bun.which("python3")

describe("verifying a Python project", () => {
  test("a healthy one comes out green — it used to come out red with `could not find Cargo.toml`", async () => {
    if (!hasPython) return
    const verdict = await verifyDeterministic(project(PY_OK))
    expect(verdict.ok).toBe(true)
    expect(verdict.checks.find(c => c.name === "pruebas")?.status).toBe("passed")
    expect(JSON.stringify(verdict)).not.toContain("Cargo")
  }, 60000)

  test("a failing test is a failure, with what failed", async () => {
    if (!hasPython) return
    const dir = project({ ...PY_OK, "tests/test_main.py": "import unittest\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(1, 2)\n" })
    const verdict = await verifyDeterministic(dir)
    expect(verdict.ok).toBe(false)
    const tests = verdict.checks.find(c => c.name === "pruebas")!
    expect(tests.status).toBe("failed")
    expect(tests.detail).toContain("AssertionError")
  }, 60000)

  test("pytest-style tests with no pytest installed are not applicable, not a failure", async () => {
    if (!hasPython || !!Bun.spawnSync(["python3", "-m", "pytest", "--version"], { stdout: "ignore", stderr: "ignore" }).success) return
    const verdict = await verifyDeterministic(project({ "tests/test_a.py": "def test_a():\n    assert True\n" }))
    expect(verdict.ok).toBe(true)
    expect(verdict.checks.find(c => c.name === "pruebas")).toMatchObject({ status: "skipped" })
    expect(verdict.checks.find(c => c.name === "pruebas")!.detail).toContain("pytest no está instalado")
  })
})

describe("other stacks, and projects nobody recognises", () => {
  test("a Maven project without the toolchain is reported as not applicable, and does not fail", async () => {
    if (Bun.which("mvn") || Bun.which("javac")) return // a machine that has them would really run it
    const verdict = await verifyDeterministic(project({ "pom.xml": "<project/>", "src/test/java/AppTest.java": "class AppTest {}" }))
    expect(verdict.ok).toBe(true)
    expect(verdict.checks.length).toBeGreaterThan(0)
    expect(verdict.checks.every(c => c.status === "skipped")).toBe(true)
    expect(verdict.checks[0]!.detail).toContain("no está instalado")
  })

  test("a project of no ecosystem gets no checks, and so nothing can fail", async () => {
    const dir = project({ "notes.txt": "hello" })
    expect(planChecks(dir)).toEqual([])
    expect((await verifyDeterministic(dir)).ok).toBe(true)
  })

  test("what the project declares in .hivecode/verify.json is what runs", async () => {
    const dir = project({ "Makefile": "x:\n", ".hivecode/verify.json": JSON.stringify({ test: "echo declared-test-ran" }) })
    const verdict = await verifyDeterministic(dir)
    expect(verdict.checks).toEqual([{ name: "pruebas", status: "passed", detail: "" }])
  })

  test("a JavaScript project keeps its own path", () => {
    const dir = project({ "package.json": JSON.stringify({ scripts: { test: "bun test", build: "echo b" } }), "a.test.ts": "" })
    expect(planChecks(dir).map(c => `${c.ecosystem}:${c.label}`)).toEqual(["node:pruebas", "node:build"])
  })
})

describe("the tools no longer fall back to another language", () => {
  const tool = (name: string) => createAllTools({} as never).find(t => t.name === name)!

  test("code_test on a Python project runs its tests, not `cargo test`", async () => {
    if (!hasPython) return
    const result: any = await tool("code_test").execute({ path: project(PY_OK) }, {} as never)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain("Cargo")
  }, 60000)

  test("code_test and code_build on a project they do not recognise say so instead of guessing", async () => {
    const dir = project({ "notes.txt": "x" })
    const test: any = await tool("code_test").execute({ path: dir }, {} as never)
    const build: any = await tool("code_build").execute({ path: dir }, {} as never)
    expect(test.ok).toBe(false)
    expect(test.error).toContain("No se reconoce cómo probar")
    expect(test.error).toContain(".hivecode/verify.json")
    expect(build.ok).toBe(false)
    expect(build.error).toContain("No se reconoce cómo compilar")
  })
})

describe("what the harness knows and tells the agent", () => {
  test("the facts tell JavaScript from the rest, and a Python project has tests", () => {
    const python = readProjectFacts(project(PY_OK))
    expect(python).toMatchObject({ hasTests: true, hasJavaScript: false, ecosystems: ["python"] })
    const polyglot = readProjectFacts(project({ "package.json": "{}", "main.ts": "", ...PY_OK }))
    expect(polyglot.ecosystems).toEqual(["node", "python"])
    expect(readProjectFacts(project({ "notes.txt": "x" })).ecosystems).toEqual([])
  })

  test("the text for the agent names the ecosystem and the command, and says nothing of tsconfig", () => {
    const dir = project(PY_OK)
    const planned = planChecks(dir)
    const text = describeProjectFacts(readProjectFacts(dir), planned.filter(p => !p.skip).map(p => p.label), planned.filter(p => p.command && !p.skip).map(p => `${p.label} (${p.ecosystem}): \`${p.command}\``))
    expect(text).toContain("ecosistema: python")
    expect(text).not.toContain("tsconfig")
    if (hasPython) expect(text).toContain("python3 -m")
  })
})
