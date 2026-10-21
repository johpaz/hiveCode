import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeEcosystemChecks, planVerification, realEnv, type Env } from "./ecosystems"

const made: string[] = []
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "eco-"))
  made.push(dir)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file.split("/").slice(0, -1).join("/") || "."), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}

/** An environment with exactly these executables, and these probes answering yes. */
const env = (bins: string[], probes: string[] = []): Env => ({
  which: bin => bins.includes(bin),
  probe: argv => probes.includes(argv.join(" ")),
})

const run = (dir: string, command: string) => Bun.spawnSync(["/bin/sh", "-c", command], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 180_000 })
const byLabel = (plan: ReturnType<typeof planVerification>, label: string) => plan.checks.find(k => k.label === label)

describe("a project is never verified with another language's tool", () => {
  test("Python and Java no longer fall back to `cargo test`", () => {
    const python = planVerification(project({ "pyproject.toml": "[project]\nname='x'\n", "tests/test_a.py": "import unittest\n" }), env(["python3"]))
    const java = planVerification(project({ "pom.xml": "<project/>", "src/test/java/AppTest.java": "class AppTest {}" }), env([]))
    for (const plan of [python, java]) expect(plan.checks.map(k => k.command).join(" ")).not.toContain("cargo")
  })

  test("an ecosystem nobody recognises gets no check at all", () => {
    const plan = planVerification(project({ "notes.txt": "hello", "data/a.csv": "1,2" }), env(["cargo", "python3", "make"]))
    expect(plan.ecosystems).toEqual([])
    expect(plan.checks).toEqual([])
    expect(plan.hasTests).toBe(false)
  })
})

describe("python", () => {
  test("unittest tests run with the standard library when pytest is not installed — for real", () => {
    if (!realEnv.which("python3")) return
    const dir = project({
      "app/__init__.py": "",
      "app/main.py": "def f():\n    return 1\n",
      "tests/__init__.py": "",
      "tests/test_main.py": "import unittest\nfrom app.main import f\n\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(f(), 1)\n",
    })
    const plan = planVerification(dir, env(["python3"])) // no pytest
    const tests = byLabel(plan, "pruebas")!
    expect(tests.skip).toBeUndefined()
    expect(tests.command).toBe("python3 -m unittest discover -q")
    expect(plan.hasTests).toBe(true)
    expect(run(dir, tests.command).exitCode).toBe(0)
  })

  test("a failing unittest is a failing check", () => {
    if (!realEnv.which("python3")) return
    const dir = project({ "tests/__init__.py": "", "tests/test_x.py": "import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertEqual(1, 2)\n" })
    expect(run(dir, byLabel(planVerification(dir, env(["python3"])), "pruebas")!.command).exitCode).not.toBe(0)
  })

  test("pytest-style tests with no pytest installed do not apply: not unittest, not a failure", () => {
    const dir = project({ "tests/test_a.py": "def test_a():\n    assert 1 == 1\n" })
    const tests = byLabel(planVerification(dir, env(["python3"])), "pruebas")!
    expect(tests.skip).toContain("pytest no está instalado")
  })

  test("pytest is used when it is importable", () => {
    const dir = project({ "tests/test_a.py": "def test_a():\n    assert 1 == 1\n" })
    const plan = planVerification(dir, env(["python3"], ["python3 -m pytest --version"]))
    expect(byLabel(plan, "pruebas")).toMatchObject({ command: "python3 -m pytest -q" })
    expect(byLabel(plan, "pruebas")!.skip).toBeUndefined()
  })

  test("types are checked only if the project configured mypy", () => {
    const without = planVerification(project({ "a.py": "x = 1\n" }), env(["python3"]))
    const withMypy = planVerification(project({ "a.py": "x = 1\n", "mypy.ini": "[mypy]\n" }), env(["python3"], ["python3 -m mypy --version"]))
    expect(byLabel(without, "tipos")).toBeUndefined()
    expect(byLabel(withMypy, "tipos")?.command).toBe("python3 -m mypy .")
  })
})

describe("java, go and the rest: chosen by what the project has, skipped when the toolchain is missing", () => {
  test("Maven: its wrapper when there is one, `mvn` otherwise, and a JDK is needed either way", () => {
    const files = { "pom.xml": "<project/>", "src/test/java/AppTest.java": "class AppTest {}" }
    const plain = planVerification(project(files), env(["mvn", "javac"]))
    expect(byLabel(plain, "pruebas")).toMatchObject({ command: "mvn -q -B test" })
    expect(byLabel(plain, "pruebas")!.skip).toBeUndefined()
    const wrapped = planVerification(project({ ...files, mvnw: "#!/bin/sh\n" }), env(["javac"]))
    expect(byLabel(wrapped, "pruebas")).toMatchObject({ command: "./mvnw -q -B test" })
    const noJdk = planVerification(project(files), env(["mvn"]))
    expect(byLabel(noJdk, "pruebas")!.skip).toContain("javac no está instalado")
    expect(byLabel(noJdk, "build")!.skip).toContain("javac")
  })

  test("Gradle: `gradle test`, or the wrapper", () => {
    const plan = planVerification(project({ "build.gradle.kts": "", "src/test/kotlin/AppTest.kt": "" }), env(["gradle", "javac"]))
    expect(byLabel(plan, "pruebas")).toMatchObject({ command: "gradle -q test" })
    expect(byLabel(plan, "build")).toMatchObject({ command: "gradle -q build -x test" })
  })

  test("Go: test, build and vet; skipped without the toolchain", () => {
    const files = { "go.mod": "module x\n", "main.go": "package main\n", "main_test.go": "package main\n" }
    const present = planVerification(project(files), env(["go"]))
    expect(present.checks.map(k => k.command)).toEqual(["go test ./...", "go build ./...", "go vet ./..."])
    const absent = planVerification(project(files), env([]))
    expect(absent.checks.every(k => !!k.skip)).toBe(true)
    expect(absent.checks[0]!.skip).toContain("go no está instalado")
  })

  test(".NET, PHP, Ruby, Swift, Elixir, Dart and Scala each pick their own runner", () => {
    const pick = (files: Record<string, string>, bins: string[]) => planVerification(project(files), env(bins)).checks.map(k => k.command)
    expect(pick({ "App.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PackageReference Include="Microsoft.NET.Test.Sdk"/></Project>' }, ["dotnet"])).toEqual(["dotnet test", "dotnet build"])
    expect(pick({ "composer.json": "{}", "phpunit.xml": "", "vendor/bin/phpunit": "" }, ["php"])).toEqual(["vendor/bin/phpunit"]) // the local one, no composer needed
    expect(pick({ "composer.json": "{}", "phpunit.xml": "" }, ["php", "composer"])).toEqual(["composer test"])
    expect(pick({ Gemfile: "", "spec/a_spec.rb": "" }, ["bundle"])).toEqual(["bundle exec rspec"])
    expect(pick({ Gemfile: "", "test/a_test.rb": "" }, ["bundle"])).toEqual(["bundle exec rake test"])
    expect(pick({ "Package.swift": "", "Tests/AppTests/A.swift": "" }, ["swift"])).toEqual(["swift test", "swift build"])
    expect(pick({ "mix.exs": "", "test/a_test.exs": "" }, ["mix"])).toEqual(["mix test", "mix compile"])
    expect(pick({ "pubspec.yaml": "name: a\n", "test/a_test.dart": "" }, ["dart"])).toEqual(["dart test"])
    expect(pick({ "build.sbt": "", "src/test/scala/A.scala": "" }, ["sbt"])).toEqual(["sbt test"])
  })
})

describe("rust, C/C++ and make: run for real where the toolchain is here", () => {
  test("a Rust crate: tests are found and `cargo test` passes", () => {
    if (!realEnv.which("cargo")) return
    const dir = project({
      "Cargo.toml": '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": "pub fn f() -> i32 { 1 }\n#[cfg(test)]\nmod tests { #[test] fn works() { assert_eq!(super::f(), 1); } }\n",
    })
    const plan = planVerification(dir, realEnv)
    expect(plan.hasTests).toBe(true)
    expect(byLabel(plan, "pruebas")).toMatchObject({ command: "cargo test" })
    expect(run(dir, "cargo test").exitCode).toBe(0)
  }, 240_000)

  test("a CMake project with CTest: configure, build and test in one command — for real", () => {
    if (!realEnv.which("cmake") || !(realEnv.which("cc") || realEnv.which("gcc"))) return
    const dir = project({
      "CMakeLists.txt": "cmake_minimum_required(VERSION 3.10)\nproject(t C)\nenable_testing()\nadd_executable(t t.c)\nadd_test(NAME t COMMAND t)\n",
      "t.c": "int main(void) { return 0; }\n",
    })
    const plan = planVerification(dir, realEnv)
    expect(plan.hasTests).toBe(true)
    const tests = byLabel(plan, "pruebas")!
    expect(tests.command).toContain("ctest")
    expect(tests.skip).toBeUndefined()
    expect(run(dir, tests.command).exitCode).toBe(0)
  }, 240_000)

  test("a project that only has a Makefile with a test target — for real", () => {
    if (!realEnv.which("make")) return
    const dir = project({ Makefile: "test:\n\t@echo ok\n" })
    const plan = planVerification(dir, realEnv)
    expect(byLabel(plan, "pruebas")).toMatchObject({ command: "make test" })
    expect(run(dir, "make test").exitCode).toBe(0)
  })
})

describe("what the project declares wins, and polyglot projects are both", () => {
  test(".hivecode/verify.json replaces the commands we would have chosen, for the labels it covers", () => {
    const dir = project({
      "Cargo.toml": "[package]\n", "src/lib.rs": "#[test] fn a() {}\n",
      ".hivecode/verify.json": JSON.stringify({ test: "just test", typecheck: "just lint" }),
    })
    const plan = planVerification(dir, env(["cargo"]))
    expect(byLabel(plan, "pruebas")).toMatchObject({ command: "just test", ecosystem: "declarado" })
    expect(byLabel(plan, "tipos")).toMatchObject({ command: "just lint" })
    expect(byLabel(plan, "build")).toMatchObject({ command: "cargo build" }) // not declared: ours stays
    expect(plan.checks.filter(k => k.label === "pruebas")).toHaveLength(1)
  })

  test("a broken verify.json is ignored, not fatal", () => {
    const plan = planVerification(project({ "go.mod": "module x\n", ".hivecode/verify.json": "{not json" }), env(["go"]))
    expect(byLabel(plan, "build")).toMatchObject({ command: "go build ./..." })
  })

  test("a project that is also JavaScript says so, and its other half is still verified", () => {
    const plan = planVerification(project({ "package.json": "{}", "Cargo.toml": "[package]\n", "src/lib.rs": "" }), env(["cargo"]))
    expect(plan.ecosystems).toEqual(["node", "rust"])
    expect(byLabel(plan, "build")).toMatchObject({ command: "cargo build" })
  })

  test("the make fallback is not used when an ecosystem already has tests, nor next to a package.json", () => {
    const withPython = planVerification(project({ Makefile: "test:\n\t@true\n", "tests/test_a.py": "import unittest\n" }), env(["python3", "make"]))
    expect(withPython.checks.some(k => k.command === "make test")).toBe(false)
    const withNode = planVerification(project({ Makefile: "test:\n\t@true\n", "package.json": "{}" }), env(["make"]))
    expect(withNode.checks).toEqual([])
  })
})

describe("what the agent is told", () => {
  test("says what will run and what will not, with the reason", () => {
    const plan = planVerification(project({ "pom.xml": "<project/>", "src/test/java/AppTest.java": "" }), env(["mvn"]))
    const text = describeEcosystemChecks(plan)
    expect(text).toContain("pruebas (java): no se comprobará")
    expect(text).toContain("javac no está instalado")
    const ok = describeEcosystemChecks(planVerification(project({ "go.mod": "module x\n", "a_test.go": "" }), env(["go"])))
    expect(ok).toContain("`go test ./...`")
  })

  test("is empty when there is nothing to say", () => {
    expect(describeEcosystemChecks(planVerification(project({ "notes.txt": "x" }), env([])))).toBe("")
  })
})
