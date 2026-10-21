/**
 * What "verify this project" means in each ecosystem.
 *
 * The harness used to know one: Bun and TypeScript. With no `package.json` it fell back to `cargo test`, so a
 * perfectly healthy Python or Java project came out red ("could not find Cargo.toml") and the agent was sent
 * to repair what was not broken. Verification is now data: for each ecosystem, how to recognise it, how to
 * tell that it has tests, and which commands run its tests, build and type check.
 *
 * Three rules hold for every ecosystem:
 *  - A check whose toolchain is not installed does not apply. It is reported as skipped, with how to install
 *    it, never as a failure: a missing `mvn` says nothing about the code.
 *  - An ecosystem nobody recognises gets no check at all. There is no default command to fall back on.
 *  - What the project declares wins: `.hivecode/verify.json` replaces the commands we would have chosen.
 *
 * JavaScript and TypeScript keep their own path (package.json scripts, bun, tsc); this covers the rest and
 * says when a project is also one of those.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

export type CheckLabel = "pruebas" | "build" | "tipos"

export interface EcosystemCheck {
  ecosystem: string
  label: CheckLabel
  command: string
  /** Why it does not apply here (toolchain missing, nothing to run). Present means: report, do not run. */
  skip?: string
}

export interface Env {
  /** Is this executable on the PATH? */
  which(bin: string): boolean
  /** Does this command exit 0? For "is pytest importable" and the like. */
  probe(argv: string[]): boolean
}

export const realEnv: Env = {
  which: bin => !!Bun.which(bin),
  probe: argv => {
    try { return Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore", timeout: 8000 }).exitCode === 0 } catch { return false }
  },
}

/** Directories that hold dependencies or build output, never the project's own code. */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "target", "build", "dist", "out", "venv", ".venv", "env", "__pycache__", ".gradle", ".idea",
  "vendor", "bin", "obj", ".tox", ".mypy_cache", ".pytest_cache", "coverage", ".next", ".dart_tool", "_build", "deps",
])

/** The project's files as relative paths, bounded: enough to recognise an ecosystem, never a full crawl. */
export function listFiles(dir: string, limit = 3000): string[] {
  const out: string[] = []
  const queue: string[] = [""]
  while (queue.length && out.length < limit) {
    const rel = queue.shift()!
    let entries: string[]
    try { entries = readdirSync(join(dir, rel)) } catch { continue }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name)) continue
      const path = rel ? `${rel}/${name}` : name
      let isDir = false
      try { isDir = statSync(join(dir, path)).isDirectory() } catch { continue }
      if (isDir) queue.push(path)
      else out.push(path)
      if (out.length >= limit) break
    }
  }
  return out
}

interface Ctx {
  dir: string
  files: string[]
  env: Env
  has(file: string): boolean
  read(file: string): string
  any(pattern: RegExp): boolean
  /** The first of these executables that is missing, or undefined when all are there. */
  missing(...bins: string[]): string | undefined
}

function context(dir: string, env: Env): Ctx {
  const files = listFiles(dir)
  return {
    dir, files, env,
    has: file => existsSync(join(dir, file)),
    read: file => { try { return readFileSync(join(dir, file), "utf8") } catch { return "" } },
    any: pattern => files.some(file => pattern.test(file)),
    missing: (...bins) => bins.find(bin => !env.which(bin)),
  }
}

interface Ecosystem {
  id: string
  name: string
  detect(c: Ctx): boolean
  hasTests(c: Ctx): boolean
  checks(c: Ctx): EcosystemCheck[]
}

const check = (ecosystem: string, label: CheckLabel, command: string, skip?: string): EcosystemCheck =>
  ({ ecosystem, label, command, ...(skip && { skip }) })

/** A check that needs `bins`: it runs when they exist, and is skipped, with the install hint, when not. */
function needing(c: Ctx, id: string, label: CheckLabel, command: string, bins: string[], hint: string): EcosystemCheck {
  const absent = c.missing(...bins)
  return check(id, label, command, absent ? `${absent} no está instalado (${hint})` : undefined)
}

const ECOSYSTEMS: Ecosystem[] = [
  {
    id: "python", name: "Python",
    detect: c => c.has("pyproject.toml") || c.has("setup.py") || c.has("setup.cfg") || c.has("requirements.txt") || c.has("Pipfile") || c.has("tox.ini") || c.any(/\.py$/),
    hasTests: c => c.any(/(^|\/)(test_[^/]*|[^/]*_test)\.py$/) || c.any(/(^|\/)tests?\/.*\.py$/),
    checks(c) {
      const py = c.env.which("python3") ? "python3" : c.env.which("python") ? "python" : undefined
      const out: EcosystemCheck[] = []
      if (!py) return [check("python", "pruebas", "python3 -m unittest discover -q", "python no está instalado")]
      if (python_hasTests(c)) {
        const testSources = c.files.filter(f => /\.py$/.test(f) && /(^|\/)(test_[^/]*|[^/]*_test)\.py$|(^|\/)tests?\//.test(f)).map(f => c.read(f)).join("\n")
        const unittestStyle = /^\s*(import unittest|from unittest)/m.test(testSources)
        const pytestConfigured = c.has("pytest.ini") || c.has("conftest.py") || /\[tool\.pytest/.test(c.read("pyproject.toml")) || /\[(tool:)?pytest\]/.test(`${c.read("setup.cfg")}\n${c.read("tox.ini")}`)
        if (c.env.probe([py, "-m", "pytest", "--version"])) out.push(check("python", "pruebas", `${py} -m pytest -q`))
        else if (unittestStyle && !pytestConfigured) out.push(check("python", "pruebas", `${py} -m unittest discover -q`))
        else out.push(check("python", "pruebas", `${py} -m pytest -q`, "pytest no está instalado (pip install pytest)"))
      }
      // Types are checked only where the project asked for it: a mypy configuration.
      const mypyConfigured = c.has("mypy.ini") || /\[tool\.mypy\]/.test(c.read("pyproject.toml")) || /\[mypy\]/.test(c.read("setup.cfg"))
      if (mypyConfigured) {
        out.push(c.env.probe([py, "-m", "mypy", "--version"])
          ? check("python", "tipos", `${py} -m mypy .`)
          : check("python", "tipos", `${py} -m mypy .`, "mypy no está instalado (pip install mypy)"))
      }
      return out
    },
  },
  {
    id: "java", name: "Java/Kotlin (Maven o Gradle)",
    detect: c => c.has("pom.xml") || c.has("build.gradle") || c.has("build.gradle.kts") || c.has("settings.gradle") || c.has("settings.gradle.kts"),
    hasTests: c => c.any(/(^|\/)src\/test\/.+\.(java|kt|scala|groovy)$/),
    checks(c) {
      const maven = c.has("pom.xml")
      const wrapper = maven ? c.has("mvnw") : c.has("gradlew")
      const tool = maven ? (wrapper ? "./mvnw" : "mvn") : (wrapper ? "./gradlew" : "gradle")
      const bins = [...(wrapper ? [] : [tool]), "javac"]
      const hint = maven ? "instala un JDK y Maven" : "instala un JDK y Gradle"
      const out: EcosystemCheck[] = []
      if (java_hasTests(c)) out.push(needing(c, "java", "pruebas", maven ? `${tool} -q -B test` : `${tool} -q test`, bins, hint))
      out.push(needing(c, "java", "build", maven ? `${tool} -q -B -DskipTests package` : `${tool} -q build -x test`, bins, hint))
      return out
    },
  },
  {
    id: "go", name: "Go",
    detect: c => c.has("go.mod"),
    hasTests: c => c.any(/_test\.go$/),
    checks: c => [
      ...(c.any(/_test\.go$/) ? [needing(c, "go", "pruebas", "go test ./...", ["go"], "instala Go")] : []),
      needing(c, "go", "build", "go build ./...", ["go"], "instala Go"),
      needing(c, "go", "tipos", "go vet ./...", ["go"], "instala Go"),
    ],
  },
  {
    id: "rust", name: "Rust",
    detect: c => c.has("Cargo.toml"),
    hasTests: c => c.any(/(^|\/)tests\/.+\.rs$/) || c.files.filter(f => f.endsWith(".rs")).some(f => /#\[(tokio::)?test\]|#\[cfg\(test\)\]/.test(c.read(f))),
    checks: c => [
      ...(rust_hasTests(c) ? [needing(c, "rust", "pruebas", "cargo test", ["cargo"], "instala Rust con rustup")] : []),
      needing(c, "rust", "build", "cargo build", ["cargo"], "instala Rust con rustup"),
    ],
  },
  {
    id: "dotnet", name: ".NET",
    detect: c => c.any(/\.(sln|csproj|fsproj|vbproj)$/),
    hasTests: c => c.any(/Tests?\.(cs|fs)$/) || c.files.filter(f => /\.(cs|fs)proj$/.test(f)).some(f => /Microsoft\.NET\.Test\.Sdk/.test(c.read(f))),
    checks: c => [
      ...(dotnet_hasTests(c) ? [needing(c, "dotnet", "pruebas", "dotnet test", ["dotnet"], "instala el SDK de .NET")] : []),
      needing(c, "dotnet", "build", "dotnet build", ["dotnet"], "instala el SDK de .NET"),
    ],
  },
  {
    id: "php", name: "PHP",
    detect: c => c.has("composer.json"),
    hasTests: c => c.has("phpunit.xml") || c.has("phpunit.xml.dist") || c.any(/(^|\/)tests?\/.+\.php$/),
    checks(c) {
      if (!php_hasTests(c)) return []
      const local = c.has("vendor/bin/phpunit")
      return [needing(c, "php", "pruebas", local ? "vendor/bin/phpunit" : "composer test", local ? ["php"] : ["php", "composer"], "instala PHP y Composer, y ejecuta composer install")]
    },
  },
  {
    id: "ruby", name: "Ruby",
    detect: c => c.has("Gemfile") || c.any(/\.gemspec$/) || c.has("Rakefile"),
    hasTests: c => c.any(/(^|\/)(spec|test)\/.+\.rb$/),
    checks(c) {
      if (!ruby_hasTests(c)) return []
      const rspec = c.any(/(^|\/)spec\/.+\.rb$/)
      return [needing(c, "ruby", "pruebas", rspec ? "bundle exec rspec" : "bundle exec rake test", ["bundle"], "instala Ruby y Bundler")]
    },
  },
  {
    id: "swift", name: "Swift",
    detect: c => c.has("Package.swift"),
    hasTests: c => c.any(/(^|\/)Tests\/.+\.swift$/),
    checks: c => [
      ...(c.any(/(^|\/)Tests\/.+\.swift$/) ? [needing(c, "swift", "pruebas", "swift test", ["swift"], "instala Swift")] : []),
      needing(c, "swift", "build", "swift build", ["swift"], "instala Swift"),
    ],
  },
  {
    id: "cmake", name: "C/C++ (CMake)",
    detect: c => c.has("CMakeLists.txt"),
    hasTests: c => /enable_testing|add_test|gtest_discover_tests|catch_discover_tests/.test(c.read("CMakeLists.txt")),
    checks(c) {
      const bins = ["cmake"]
      const configure = "cmake -S . -B build"
      const out = [needing(c, "cmake", "build", `${configure} && cmake --build build`, bins, "instala CMake y un compilador de C/C++")]
      if (cmake_hasTests(c)) out.unshift(needing(c, "cmake", "pruebas", `${configure} && cmake --build build && ctest --test-dir build --output-on-failure`, bins, "instala CMake y un compilador de C/C++"))
      return out
    },
  },
  {
    id: "elixir", name: "Elixir",
    detect: c => c.has("mix.exs"),
    hasTests: c => c.any(/(^|\/)test\/.+_test\.exs$/),
    checks: c => [
      ...(c.any(/(^|\/)test\/.+_test\.exs$/) ? [needing(c, "elixir", "pruebas", "mix test", ["mix"], "instala Elixir")] : []),
      needing(c, "elixir", "build", "mix compile", ["mix"], "instala Elixir"),
    ],
  },
  {
    id: "dart", name: "Dart/Flutter",
    detect: c => c.has("pubspec.yaml"),
    hasTests: c => c.any(/(^|\/)test\/.+_test\.dart$/),
    checks(c) {
      const flutter = /^\s*flutter:\s*$/m.test(c.read("pubspec.yaml")) && /sdk:\s*flutter/.test(c.read("pubspec.yaml"))
      return c.any(/(^|\/)test\/.+_test\.dart$/)
        ? [needing(c, "dart", "pruebas", flutter ? "flutter test" : "dart test", [flutter ? "flutter" : "dart"], "instala el SDK de Dart/Flutter")]
        : []
    },
  },
  {
    id: "scala", name: "Scala (sbt)",
    detect: c => c.has("build.sbt"),
    hasTests: c => c.any(/(^|\/)src\/test\/.+\.scala$/),
    checks: c => c.any(/(^|\/)src\/test\/.+\.scala$/) ? [needing(c, "scala", "pruebas", "sbt test", ["sbt"], "instala sbt")] : [],
  },
]

// The `hasTests` of each ecosystem, named so `checks` can ask without re-deriving it.
function python_hasTests(c: Ctx) { return find("python").hasTests(c) }
function java_hasTests(c: Ctx) { return find("java").hasTests(c) }
function rust_hasTests(c: Ctx) { return find("rust").hasTests(c) }
function dotnet_hasTests(c: Ctx) { return find("dotnet").hasTests(c) }
function php_hasTests(c: Ctx) { return find("php").hasTests(c) }
function ruby_hasTests(c: Ctx) { return find("ruby").hasTests(c) }
function cmake_hasTests(c: Ctx) { return find("cmake").hasTests(c) }
function find(id: string): Ecosystem { return ECOSYSTEMS.find(e => e.id === id)! }

/** `make test` / `make check`, for a project that only has a Makefile and no ecosystem we recognise. */
function makefileChecks(c: Ctx): EcosystemCheck[] {
  if (!c.has("Makefile")) return []
  const text = c.read("Makefile")
  const target = /^test:/m.test(text) ? "test" : /^check:/m.test(text) ? "check" : undefined
  return target ? [needing(c, "make", "pruebas", `make ${target}`, ["make"], "instala make")] : []
}

/** What the project itself declares in `.hivecode/verify.json`: `{ "test": "...", "build": "...", "typecheck": "..." }`. */
function declaredChecks(c: Ctx): EcosystemCheck[] {
  const raw = c.read(".hivecode/verify.json")
  if (!raw) return []
  try {
    const declared = JSON.parse(raw) as Record<string, unknown>
    const out: EcosystemCheck[] = []
    for (const [key, label] of [["test", "pruebas"], ["build", "build"], ["typecheck", "tipos"]] as const) {
      const command = declared[key]
      if (typeof command === "string" && command.trim()) out.push(check("declarado", label, command.trim()))
    }
    return out
  } catch { return [] }
}

export interface EcosystemPlan {
  /** The ids of the ecosystems found, in order; "node" when there is a package.json. */
  ecosystems: string[]
  /** Checks for everything but JavaScript/TypeScript, which has its own path. */
  checks: EcosystemCheck[]
  /** True when a non-JavaScript ecosystem found tests, so the project is not "without tests" for the harness. */
  hasTests: boolean
}

/** Recognises the project and plans its verification. Pure apart from reading the project and probing the PATH. */
export function planVerification(dir: string, env: Env = realEnv): EcosystemPlan {
  const c = context(dir, env)
  const declared = declaredChecks(c)
  const found = ECOSYSTEMS.filter(e => e.detect(c))
  const ecosystems = [...(c.has("package.json") ? ["node"] : []), ...found.map(e => e.id)]
  // The project's own commands replace ours for the labels they cover.
  const covered = new Set(declared.map(d => d.label))
  const chosen = found.flatMap(e => e.checks(c)).filter(k => !covered.has(k.label))
  const checks = [...declared, ...chosen]
  if (!checks.some(k => k.label === "pruebas") && !c.has("package.json")) checks.push(...makefileChecks(c))
  const hasTests = found.some(e => e.hasTests(c)) || declared.some(d => d.label === "pruebas")
  return { ecosystems, checks, hasTests }
}

/**
 * Which ecosystems this is and whether they have tests, without running or probing anything: cheap enough for
 * the facts the harness reads at the start of every task.
 */
export function detectProject(dir: string): { ecosystems: string[]; hasTests: boolean } {
  const c = context(dir, { which: () => false, probe: () => false })
  const found = ECOSYSTEMS.filter(e => e.detect(c))
  return { ecosystems: found.map(e => e.id), hasTests: found.some(e => e.hasTests(c)) }
}

/** One line per check for the agent: what the harness will run by itself, and what it will not. */
export function describeEcosystemChecks(plan: EcosystemPlan): string {
  if (!plan.checks.length) return ""
  return plan.checks
    .map(k => k.skip ? `- ${k.label} (${k.ecosystem}): no se comprobará — ${k.skip}` : `- ${k.label} (${k.ecosystem}): \`${k.command}\``)
    .join("\n")
}
