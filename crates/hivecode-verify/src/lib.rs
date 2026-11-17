//! What "verify this project" means in each ecosystem.
//!
//! Verification is data: for every ecosystem, how to recognise it, how to tell it has tests, and
//! which commands run its tests, build and type check. Three rules hold for all of them:
//!  - A check whose toolchain is not installed does not apply: it is reported as skipped, with how
//!    to install it, never as a failure. A missing `mvn` says nothing about the code.
//!  - An ecosystem nobody recognises gets no check at all; there is no default command.
//!  - What the project declares wins: `.hivecode/verify.json` replaces the commands we would pick.
//!
//! JavaScript/TypeScript: tests and build come from the `package.json` scripts through the package
//! manager the lockfile names; types only with a tsconfig *and* an installed compiler.
use regex::Regex;
use std::{collections::VecDeque, path::Path, process::Stdio, sync::LazyLock, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Label {
    Tests,
    Build,
    Types,
}
impl Label {
    pub fn as_str(self) -> &'static str {
        match self {
            Label::Tests => "pruebas",
            Label::Build => "build",
            Label::Types => "tipos",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "pruebas" | "tests" | "test" => Some(Label::Tests),
            "build" => Some(Label::Build),
            "tipos" | "types" | "typecheck" => Some(Label::Types),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub ecosystem: String,
    pub label: Label,
    pub command: String,
    /// Why it does not apply here. Present means: report it, do not run it.
    pub skip: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Ids of the ecosystems found, in order; `node` first when there is a package.json.
    pub ecosystems: Vec<String>,
    pub checks: Vec<Check>,
    /// True when a non-JavaScript ecosystem found tests (or the project declared a test command).
    pub has_tests: bool,
}

/// The machine the plan is made for.
pub trait Env {
    fn which(&self, bin: &str) -> bool;
    /// Does this command exit 0? For "is pytest importable" and the like.
    fn probe(&self, argv: &[&str]) -> bool;
}

pub struct RealEnv;
impl Env for RealEnv {
    fn which(&self, bin: &str) -> bool {
        let Some(path) = std::env::var_os("PATH") else {
            return false;
        };
        std::env::split_paths(&path).any(|dir| {
            let file = dir.join(bin);
            file.is_file() || cfg!(windows) && dir.join(format!("{bin}.exe")).is_file()
        })
    }
    fn probe(&self, argv: &[&str]) -> bool {
        let Some((program, args)) = argv.split_first() else {
            return false;
        };
        let Ok(mut child) = std::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    return false;
                }
            }
        }
    }
}

/// Dependency and build-output directories, never the project's own code.
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "build",
    "dist",
    "out",
    "venv",
    ".venv",
    "env",
    "__pycache__",
    ".gradle",
    ".idea",
    "vendor",
    "bin",
    "obj",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "coverage",
    ".next",
    ".dart_tool",
    "_build",
    "deps",
];

/// The project's files as relative paths, breadth first and bounded: enough to recognise an
/// ecosystem, never a full crawl.
pub fn list_files(dir: &Path, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut queue = VecDeque::from([String::new()]);
    while let Some(rel) = queue.pop_front() {
        if out.len() >= limit {
            break;
        }
        let Ok(entries) = std::fs::read_dir(dir.join(&rel)) else {
            continue;
        };
        let mut names: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        names.sort_by_key(|e| e.file_name());
        for entry in names {
            let name = entry.file_name().to_string_lossy().into_owned();
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            let path = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            match entry.metadata() {
                Ok(m) if m.is_dir() => queue.push_back(path),
                Ok(_) => out.push(path),
                Err(_) => continue,
            }
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

struct Ctx<'a> {
    dir: &'a Path,
    files: Vec<String>,
    env: &'a dyn Env,
}
impl Ctx<'_> {
    fn has(&self, file: &str) -> bool {
        self.dir.join(file).exists()
    }
    fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.dir.join(file)).unwrap_or_default()
    }
    fn any(&self, re: &Regex) -> bool {
        self.files.iter().any(|f| re.is_match(f))
    }
    fn missing(&self, bins: &[&str]) -> Option<String> {
        bins.iter()
            .find(|b| !self.env.which(b))
            .map(|b| b.to_string())
    }
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}
macro_rules! pattern {
    ($name:ident, $text:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| re($text));
    };
}
pattern!(PY_FILE, r"\.py$");
pattern!(PY_TEST, r"(^|/)(test_[^/]*|[^/]*_test)\.py$");
pattern!(PY_TEST_DIR, r"(^|/)tests?/.*\.py$");
pattern!(JAVA_TEST, r"(^|/)src/test/.+\.(java|kt|scala|groovy)$");
pattern!(GO_TEST, r"_test\.go$");
pattern!(RS_TEST_DIR, r"(^|/)tests/.+\.rs$");
pattern!(RS_FILE, r"\.rs$");
pattern!(RS_TEST_ATTR, r"#\[(tokio::)?test\]|#\[cfg\(test\)\]");
pattern!(DOTNET_PROJ, r"\.(sln|csproj|fsproj|vbproj)$");
pattern!(DOTNET_TEST, r"Tests?\.(cs|fs)$");
pattern!(DOTNET_TESTPROJ, r"\.(cs|fs)proj$");
pattern!(PHP_TEST, r"(^|/)tests?/.+\.php$");
pattern!(RUBY_GEMSPEC, r"\.gemspec$");
pattern!(RUBY_TEST, r"(^|/)(spec|test)/.+\.rb$");
pattern!(RUBY_SPEC, r"(^|/)spec/.+\.rb$");
pattern!(SWIFT_TEST, r"(^|/)Tests/.+\.swift$");
pattern!(
    CMAKE_TEST,
    r"enable_testing|add_test|gtest_discover_tests|catch_discover_tests"
);
pattern!(ELIXIR_TEST, r"(^|/)test/.+_test\.exs$");
pattern!(DART_TEST, r"(^|/)test/.+_test\.dart$");
pattern!(SCALA_TEST, r"(^|/)src/test/.+\.scala$");
pattern!(JS_TEST_FILE, r"\.(test|spec)\.[cm]?[jt]sx?$");
pattern!(
    JS_TEST_DIR,
    r"(^|/)(tests?|__tests__|spec)/.+\.[cm]?[jt]sx?$"
);
pattern!(PY_UNITTEST, r"(?m)^\s*(import unittest|from unittest)");

struct Ecosystem {
    id: &'static str,
    detect: fn(&Ctx) -> bool,
    has_tests: fn(&Ctx) -> bool,
    checks: fn(&Ctx) -> Vec<Check>,
}

fn check(ecosystem: &str, label: Label, command: &str, skip: Option<String>) -> Check {
    Check {
        ecosystem: ecosystem.into(),
        label,
        command: command.into(),
        skip,
    }
}
/// A check that needs `bins`: it runs when they exist and is skipped, with the install hint, when not.
fn needing(c: &Ctx, id: &str, label: Label, command: &str, bins: &[&str], hint: &str) -> Check {
    let skip = c
        .missing(bins)
        .map(|absent| format!("{absent} no está instalado ({hint})"));
    check(id, label, command, skip)
}

fn python_checks(c: &Ctx) -> Vec<Check> {
    let py = if c.env.which("python3") {
        "python3"
    } else if c.env.which("python") {
        "python"
    } else {
        return vec![check(
            "python",
            Label::Tests,
            "python3 -m unittest discover -q",
            Some("python no está instalado".into()),
        )];
    };
    let mut out = vec![];
    if python_has_tests(c) {
        let sources: String = c
            .files
            .iter()
            .filter(|f| PY_FILE.is_match(f) && (PY_TEST.is_match(f) || PY_TEST_DIR.is_match(f)))
            .map(|f| c.read(f))
            .collect::<Vec<_>>()
            .join("\n");
        let unittest_style = PY_UNITTEST.is_match(&sources);
        let pytest_configured = c.has("pytest.ini")
            || c.has("conftest.py")
            || c.read("pyproject.toml").contains("[tool.pytest")
            || {
                let text = format!("{}\n{}", c.read("setup.cfg"), c.read("tox.ini"));
                text.contains("[pytest]") || text.contains("[tool:pytest]")
            };
        let pytest = format!("{py} -m pytest -q");
        if c.env.probe(&[py, "-m", "pytest", "--version"]) {
            out.push(check("python", Label::Tests, &pytest, None));
        } else if unittest_style && !pytest_configured {
            out.push(check(
                "python",
                Label::Tests,
                &format!("{py} -m unittest discover -q"),
                None,
            ));
        } else {
            out.push(check(
                "python",
                Label::Tests,
                &pytest,
                Some("pytest no está instalado (pip install pytest)".into()),
            ));
        }
    }
    // Types are checked only where the project asked for it: a mypy configuration.
    let mypy_configured = c.has("mypy.ini")
        || c.read("pyproject.toml").contains("[tool.mypy]")
        || c.read("setup.cfg").contains("[mypy]");
    if mypy_configured {
        let command = format!("{py} -m mypy .");
        let skip = (!c.env.probe(&[py, "-m", "mypy", "--version"]))
            .then(|| "mypy no está instalado (pip install mypy)".to_owned());
        out.push(check("python", Label::Types, &command, skip));
    }
    out
}
fn python_has_tests(c: &Ctx) -> bool {
    c.any(&PY_TEST) || c.any(&PY_TEST_DIR)
}
fn java_has_tests(c: &Ctx) -> bool {
    c.any(&JAVA_TEST)
}
fn rust_has_tests(c: &Ctx) -> bool {
    c.any(&RS_TEST_DIR)
        || c.files
            .iter()
            .filter(|f| RS_FILE.is_match(f))
            .any(|f| RS_TEST_ATTR.is_match(&c.read(f)))
}
fn dotnet_has_tests(c: &Ctx) -> bool {
    c.any(&DOTNET_TEST)
        || c.files
            .iter()
            .filter(|f| DOTNET_TESTPROJ.is_match(f))
            .any(|f| c.read(f).contains("Microsoft.NET.Test.Sdk"))
}
fn php_has_tests(c: &Ctx) -> bool {
    c.has("phpunit.xml") || c.has("phpunit.xml.dist") || c.any(&PHP_TEST)
}
fn cmake_has_tests(c: &Ctx) -> bool {
    CMAKE_TEST.is_match(&c.read("CMakeLists.txt"))
}

/// What `package.json` declares: its scripts and whether it needs installed dependencies.
struct Package {
    scripts: Vec<String>,
    declares_dependencies: bool,
}
fn package(c: &Ctx) -> Package {
    let value: serde_json::Value =
        serde_json::from_str(&c.read("package.json")).unwrap_or_default();
    let declares = |key: &str| value[key].as_object().is_some_and(|m| !m.is_empty());
    Package {
        scripts: value["scripts"]
            .as_object()
            .map(|s| s.keys().cloned().collect())
            .unwrap_or_default(),
        declares_dependencies: declares("dependencies") || declares("devDependencies"),
    }
}
fn node_has_tests(c: &Ctx) -> bool {
    c.any(&JS_TEST_FILE) || c.any(&JS_TEST_DIR) || package(c).scripts.iter().any(|s| s == "test")
}

/// The package manager the lockfile names; without one, bun or npm if they are installed.
fn package_manager(c: &Ctx) -> &'static str {
    for (file, manager) in [
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
    ] {
        if c.has(file) {
            return manager;
        }
    }
    if c.env.which("bun") { "bun" } else { "npm" }
}

fn node_checks(c: &Ctx) -> Vec<Check> {
    let package = package(c);
    let manager = package_manager(c);
    let hint = format!("instala {manager}");
    let run = |script: &str| match manager {
        "bun" => format!("bun run {script}"),
        "pnpm" => format!("pnpm run {script}"),
        "yarn" => format!("yarn {script}"),
        _ if script == "test" => "npm test".to_owned(),
        _ => format!("npm run {script}"),
    };
    // Without node_modules, a check measures the environment, not the code: its red would be invented
    // evidence, so it is reported as skipped.
    let uninstalled = package.declares_dependencies && !c.has("node_modules");
    let gate = |mut check: Check| {
        if check.skip.is_none() && uninstalled {
            check.skip = Some(format!(
                "las dependencias no están instaladas (ejecuta {manager} install)"
            ));
        }
        check
    };
    let mut out = vec![];
    if node_has_tests(c) {
        out.push(if package.scripts.iter().any(|s| s == "test") {
            gate(needing(
                c,
                "node",
                Label::Tests,
                &run("test"),
                &[manager],
                &hint,
            ))
        } else {
            gate(needing(
                c,
                "node",
                Label::Tests,
                "bun test",
                &["bun"],
                "instala bun",
            ))
        });
    }
    // Types only with a configuration AND a compiler: `tsc` without a tsconfig, or without TypeScript
    // installed, says nothing about the code.
    let configured = c.has("tsconfig.json") || c.has("jsconfig.json");
    let compiler = c.has("node_modules/.bin/tsc") || c.has("node_modules/typescript/package.json");
    if configured && compiler {
        let tsc = match manager {
            "bun" => "bun tsc --noEmit",
            "pnpm" => "pnpm exec tsc --noEmit",
            "yarn" => "yarn tsc --noEmit",
            _ => "npx tsc --noEmit",
        };
        out.push(needing(c, "node", Label::Types, tsc, &[manager], &hint));
    }
    if package.scripts.iter().any(|s| s == "build") {
        out.push(gate(needing(
            c,
            "node",
            Label::Build,
            &run("build"),
            &[manager],
            &hint,
        )));
    }
    out
}

fn ecosystems() -> Vec<Ecosystem> {
    vec![
        Ecosystem {
            id: "node",
            detect: |c| c.has("package.json"),
            has_tests: node_has_tests,
            checks: node_checks,
        },
        Ecosystem {
            id: "python",
            detect: |c| {
                [
                    "pyproject.toml",
                    "setup.py",
                    "setup.cfg",
                    "requirements.txt",
                    "Pipfile",
                    "tox.ini",
                ]
                .iter()
                .any(|f| c.has(f))
                    || c.any(&PY_FILE)
            },
            has_tests: python_has_tests,
            checks: python_checks,
        },
        Ecosystem {
            id: "java",
            detect: |c| {
                [
                    "pom.xml",
                    "build.gradle",
                    "build.gradle.kts",
                    "settings.gradle",
                    "settings.gradle.kts",
                ]
                .iter()
                .any(|f| c.has(f))
            },
            has_tests: java_has_tests,
            checks: |c| {
                let maven = c.has("pom.xml");
                let wrapper = if maven {
                    c.has("mvnw")
                } else {
                    c.has("gradlew")
                };
                let tool = match (maven, wrapper) {
                    (true, true) => "./mvnw",
                    (true, false) => "mvn",
                    (false, true) => "./gradlew",
                    (false, false) => "gradle",
                };
                let mut bins = vec![];
                if !wrapper {
                    bins.push(tool);
                }
                bins.push("javac");
                let hint = if maven {
                    "instala un JDK y Maven"
                } else {
                    "instala un JDK y Gradle"
                };
                let mut out = vec![];
                if java_has_tests(c) {
                    let cmd = if maven {
                        format!("{tool} -q -B test")
                    } else {
                        format!("{tool} -q test")
                    };
                    out.push(needing(c, "java", Label::Tests, &cmd, &bins, hint));
                }
                let cmd = if maven {
                    format!("{tool} -q -B -DskipTests package")
                } else {
                    format!("{tool} -q build -x test")
                };
                out.push(needing(c, "java", Label::Build, &cmd, &bins, hint));
                out
            },
        },
        Ecosystem {
            id: "go",
            detect: |c| c.has("go.mod"),
            has_tests: |c| c.any(&GO_TEST),
            checks: |c| {
                let mut out = vec![];
                if c.any(&GO_TEST) {
                    out.push(needing(
                        c,
                        "go",
                        Label::Tests,
                        "go test ./...",
                        &["go"],
                        "instala Go",
                    ));
                }
                out.push(needing(
                    c,
                    "go",
                    Label::Build,
                    "go build ./...",
                    &["go"],
                    "instala Go",
                ));
                out.push(needing(
                    c,
                    "go",
                    Label::Types,
                    "go vet ./...",
                    &["go"],
                    "instala Go",
                ));
                out
            },
        },
        Ecosystem {
            id: "rust",
            detect: |c| c.has("Cargo.toml"),
            has_tests: rust_has_tests,
            checks: |c| {
                let mut out = vec![];
                if rust_has_tests(c) {
                    out.push(needing(
                        c,
                        "rust",
                        Label::Tests,
                        "cargo test",
                        &["cargo"],
                        "instala Rust con rustup",
                    ));
                }
                out.push(needing(
                    c,
                    "rust",
                    Label::Build,
                    "cargo build",
                    &["cargo"],
                    "instala Rust con rustup",
                ));
                out
            },
        },
        Ecosystem {
            id: "dotnet",
            detect: |c| c.any(&DOTNET_PROJ),
            has_tests: dotnet_has_tests,
            checks: |c| {
                let mut out = vec![];
                if dotnet_has_tests(c) {
                    out.push(needing(
                        c,
                        "dotnet",
                        Label::Tests,
                        "dotnet test",
                        &["dotnet"],
                        "instala el SDK de .NET",
                    ));
                }
                out.push(needing(
                    c,
                    "dotnet",
                    Label::Build,
                    "dotnet build",
                    &["dotnet"],
                    "instala el SDK de .NET",
                ));
                out
            },
        },
        Ecosystem {
            id: "php",
            detect: |c| c.has("composer.json"),
            has_tests: php_has_tests,
            checks: |c| {
                if !php_has_tests(c) {
                    return vec![];
                }
                let local = c.has("vendor/bin/phpunit");
                let (cmd, bins): (&str, &[&str]) = if local {
                    ("vendor/bin/phpunit", &["php"])
                } else {
                    ("composer test", &["php", "composer"])
                };
                vec![needing(
                    c,
                    "php",
                    Label::Tests,
                    cmd,
                    bins,
                    "instala PHP y Composer, y ejecuta composer install",
                )]
            },
        },
        Ecosystem {
            id: "ruby",
            detect: |c| c.has("Gemfile") || c.any(&RUBY_GEMSPEC) || c.has("Rakefile"),
            has_tests: |c| c.any(&RUBY_TEST),
            checks: |c| {
                if !c.any(&RUBY_TEST) {
                    return vec![];
                }
                let cmd = if c.any(&RUBY_SPEC) {
                    "bundle exec rspec"
                } else {
                    "bundle exec rake test"
                };
                vec![needing(
                    c,
                    "ruby",
                    Label::Tests,
                    cmd,
                    &["bundle"],
                    "instala Ruby y Bundler",
                )]
            },
        },
        Ecosystem {
            id: "swift",
            detect: |c| c.has("Package.swift"),
            has_tests: |c| c.any(&SWIFT_TEST),
            checks: |c| {
                let mut out = vec![];
                if c.any(&SWIFT_TEST) {
                    out.push(needing(
                        c,
                        "swift",
                        Label::Tests,
                        "swift test",
                        &["swift"],
                        "instala Swift",
                    ));
                }
                out.push(needing(
                    c,
                    "swift",
                    Label::Build,
                    "swift build",
                    &["swift"],
                    "instala Swift",
                ));
                out
            },
        },
        Ecosystem {
            id: "cmake",
            detect: |c| c.has("CMakeLists.txt"),
            has_tests: cmake_has_tests,
            checks: |c| {
                let hint = "instala CMake y un compilador de C/C++";
                let configure = "cmake -S . -B build";
                let mut out = vec![needing(
                    c,
                    "cmake",
                    Label::Build,
                    &format!("{configure} && cmake --build build"),
                    &["cmake"],
                    hint,
                )];
                if cmake_has_tests(c) {
                    let cmd = format!(
                        "{configure} && cmake --build build && ctest --test-dir build --output-on-failure"
                    );
                    out.insert(0, needing(c, "cmake", Label::Tests, &cmd, &["cmake"], hint));
                }
                out
            },
        },
        Ecosystem {
            id: "elixir",
            detect: |c| c.has("mix.exs"),
            has_tests: |c| c.any(&ELIXIR_TEST),
            checks: |c| {
                let mut out = vec![];
                if c.any(&ELIXIR_TEST) {
                    out.push(needing(
                        c,
                        "elixir",
                        Label::Tests,
                        "mix test",
                        &["mix"],
                        "instala Elixir",
                    ));
                }
                out.push(needing(
                    c,
                    "elixir",
                    Label::Build,
                    "mix compile",
                    &["mix"],
                    "instala Elixir",
                ));
                out
            },
        },
        Ecosystem {
            id: "dart",
            detect: |c| c.has("pubspec.yaml"),
            has_tests: |c| c.any(&DART_TEST),
            checks: |c| {
                if !c.any(&DART_TEST) {
                    return vec![];
                }
                let spec = c.read("pubspec.yaml");
                let flutter = spec
                    .lines()
                    .any(|l| l.trim_end() == "flutter:" || l.trim() == "flutter:")
                    && spec.contains("sdk: flutter");
                let (cmd, bin) = if flutter {
                    ("flutter test", "flutter")
                } else {
                    ("dart test", "dart")
                };
                vec![needing(
                    c,
                    "dart",
                    Label::Tests,
                    cmd,
                    &[bin],
                    "instala el SDK de Dart/Flutter",
                )]
            },
        },
        Ecosystem {
            id: "scala",
            detect: |c| c.has("build.sbt"),
            has_tests: |c| c.any(&SCALA_TEST),
            checks: |c| {
                if c.any(&SCALA_TEST) {
                    vec![needing(
                        c,
                        "scala",
                        Label::Tests,
                        "sbt test",
                        &["sbt"],
                        "instala sbt",
                    )]
                } else {
                    vec![]
                }
            },
        },
    ]
}

/// `make test` / `make check` for a project that only has a Makefile and no ecosystem we recognise.
fn makefile_checks(c: &Ctx) -> Vec<Check> {
    if !c.has("Makefile") {
        return vec![];
    }
    let text = c.read("Makefile");
    let target = if text.lines().any(|l| l.starts_with("test:")) {
        "test"
    } else if text.lines().any(|l| l.starts_with("check:")) {
        "check"
    } else {
        return vec![];
    };
    vec![needing(
        c,
        "make",
        Label::Tests,
        &format!("make {target}"),
        &["make"],
        "instala make",
    )]
}

/// What the project declares in `.hivecode/verify.json`: `{"test": "...", "build": "...", "typecheck": "..."}`.
fn declared_checks(c: &Ctx) -> Vec<Check> {
    let raw = c.read(".hivecode/verify.json");
    let Ok(serde_json::Value::Object(declared)) = serde_json::from_str(&raw) else {
        return vec![];
    };
    [
        ("test", Label::Tests),
        ("build", Label::Build),
        ("typecheck", Label::Types),
    ]
    .into_iter()
    .filter_map(|(key, label)| {
        let command = declared.get(key)?.as_str()?.trim();
        (!command.is_empty()).then(|| check("declarado", label, command, None))
    })
    .collect()
}

/// Recognises the project and plans its verification. Pure apart from reading the project and
/// probing the PATH through `env`.
pub fn plan(dir: &Path, env: &dyn Env) -> Plan {
    let c = Ctx {
        dir,
        files: list_files(dir, 3000),
        env,
    };
    let declared = declared_checks(&c);
    let all = ecosystems();
    let found: Vec<&Ecosystem> = all.iter().filter(|e| (e.detect)(&c)).collect();
    let names: Vec<String> = found.iter().map(|e| e.id.to_owned()).collect();
    // The project's own commands replace ours for the labels they cover.
    let covered: Vec<Label> = declared.iter().map(|d| d.label).collect();
    let mut checks = declared.clone();
    checks.extend(
        found
            .iter()
            .flat_map(|e| (e.checks)(&c))
            .filter(|k| !covered.contains(&k.label)),
    );
    if !checks.iter().any(|k| k.label == Label::Tests) && !c.has("package.json") {
        checks.extend(makefile_checks(&c));
    }
    let has_tests =
        found.iter().any(|e| (e.has_tests)(&c)) || declared.iter().any(|d| d.label == Label::Tests);
    Plan {
        ecosystems: names,
        checks,
        has_tests,
    }
}

/// Which ecosystems this is and whether they have tests, without running or probing anything.
pub fn detect(dir: &Path) -> (Vec<String>, bool) {
    struct Nothing;
    impl Env for Nothing {
        fn which(&self, _: &str) -> bool {
            false
        }
        fn probe(&self, _: &[&str]) -> bool {
            false
        }
    }
    let c = Ctx {
        dir,
        files: list_files(dir, 3000),
        env: &Nothing,
    };
    let all = ecosystems();
    let found: Vec<&Ecosystem> = all.iter().filter(|e| (e.detect)(&c)).collect();
    (
        found.iter().map(|e| e.id.to_owned()).collect(),
        found.iter().any(|e| (e.has_tests)(&c)),
    )
}

/// One line per check for the agent: what will run by itself and what will not.
pub fn describe(plan: &Plan) -> String {
    plan.checks
        .iter()
        .map(|k| match &k.skip {
            Some(why) => format!(
                "- {} ({}): no se comprobará — {why}",
                k.label.as_str(),
                k.ecosystem
            ),
            None => format!("- {} ({}): `{}`", k.label.as_str(), k.ecosystem, k.command),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub ok: bool,
    /// None when it did not finish (timeout or could not start).
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output: String,
}

/// Runs one planned check through `sh -c` in `dir`, with a deadline and a cap on the output kept
/// (the tail, where the failure is). The command is the project's own (or one declared in its
/// `.hivecode/verify.json`), so callers should treat running it like running any project code.
pub async fn run(check: &Check, dir: &Path, timeout: Duration, max_output: usize) -> Outcome {
    if let Some(why) = &check.skip {
        return Outcome {
            ok: false,
            exit_code: None,
            timed_out: false,
            output: format!("skipped: {why}"),
        };
    }
    let mut command = Command::new(if cfg!(windows) { "cmd" } else { "sh" });
    command
        .arg(if cfg!(windows) { "/C" } else { "-c" })
        .arg(&check.command);
    command
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Outcome {
                ok: false,
                exit_code: None,
                timed_out: false,
                output: format!("cannot start: {e}"),
            };
        }
    };
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let collect = async {
        let (mut a, mut b) = (Vec::new(), Vec::new());
        let (ra, rb) = tokio::join!(stdout.read_to_end(&mut a), stderr.read_to_end(&mut b));
        let _ = (ra, rb);
        let status = child.wait().await;
        (a, b, status)
    };
    match tokio::time::timeout(timeout, collect).await {
        Ok((out, err, status)) => {
            let mut all = out;
            all.extend_from_slice(&err);
            let text = String::from_utf8_lossy(&all).into_owned();
            let kept = if text.len() > max_output {
                let start = text.len() - max_output;
                let start = (start..text.len())
                    .find(|i| text.is_char_boundary(*i))
                    .unwrap_or(text.len());
                format!("[...]{}", &text[start..])
            } else {
                text
            };
            let code = status.ok().and_then(|s| s.code());
            Outcome {
                ok: code == Some(0),
                exit_code: code,
                timed_out: false,
                output: kept,
            }
        }
        Err(_) => Outcome {
            ok: false,
            exit_code: None,
            timed_out: true,
            output: format!("timed out after {}s", timeout.as_secs()),
        },
    }
}
