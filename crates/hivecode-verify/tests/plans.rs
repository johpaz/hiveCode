use hivecode_verify::{Check, Env, Label, describe, detect, plan, run};
use std::{collections::HashSet, path::Path, time::Duration};

struct Fake {
    bins: HashSet<&'static str>,
    probes: HashSet<&'static str>,
}
impl Fake {
    fn with(bins: &[&'static str]) -> Self {
        Self {
            bins: bins.iter().copied().collect(),
            probes: HashSet::new(),
        }
    }
}
impl Env for Fake {
    fn which(&self, bin: &str) -> bool {
        self.bins.contains(bin)
    }
    fn probe(&self, argv: &[&str]) -> bool {
        argv.get(2)
            .is_some_and(|module| self.probes.contains(module))
    }
}
fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, content) in files {
        let full = dir.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, content).unwrap();
    }
    dir
}
fn commands(plan: &hivecode_verify::Plan) -> Vec<(String, &'static str, String, bool)> {
    plan.checks
        .iter()
        .map(|k| {
            (
                k.ecosystem.clone(),
                k.label.as_str(),
                k.command.clone(),
                k.skip.is_some(),
            )
        })
        .collect()
}

#[test]
fn a_rust_project_with_tests_gets_test_and_build() {
    let dir = project(&[
        ("Cargo.toml", "[package]"),
        ("src/lib.rs", "#[cfg(test)] mod t { #[test] fn a() {} }"),
    ]);
    let p = plan(dir.path(), &Fake::with(&["cargo"]));
    assert_eq!(p.ecosystems, vec!["rust"]);
    assert!(p.has_tests);
    assert_eq!(
        commands(&p),
        vec![
            ("rust".into(), "pruebas", "cargo test".into(), false),
            ("rust".into(), "build", "cargo build".into(), false)
        ]
    );
}

#[test]
fn a_missing_toolchain_is_skipped_with_the_install_hint_never_a_failure() {
    let dir = project(&[("go.mod", "module x"), ("a_test.go", "package x")]);
    let p = plan(dir.path(), &Fake::with(&[]));
    assert!(p.checks.iter().all(|k| {
        k.skip
            .as_deref()
            .is_some_and(|s| s.contains("go no está instalado") && s.contains("instala Go"))
    }));
    assert_eq!(p.checks.len(), 3, "tests, build and vet");
    assert!(describe(&p).contains("no se comprobará"));
}

#[test]
fn python_prefers_pytest_when_importable_and_unittest_when_the_project_uses_it() {
    let tests = ("tests/test_a.py", "import unittest\n");
    let dir = project(&[("pyproject.toml", ""), tests]);
    let mut env = Fake::with(&["python3"]);
    env.probes.insert("pytest");
    assert_eq!(
        plan(dir.path(), &env).checks[0].command,
        "python3 -m pytest -q"
    );
    let none = plan(dir.path(), &Fake::with(&["python3"]));
    assert_eq!(
        none.checks[0].command, "python3 -m unittest discover -q",
        "unittest style and no pytest config"
    );
    assert!(none.checks[0].skip.is_none());

    let configured = project(&[("pytest.ini", ""), tests]);
    let skipped = plan(configured.path(), &Fake::with(&["python3"]));
    assert!(
        skipped.checks[0]
            .skip
            .as_deref()
            .unwrap()
            .contains("pytest no está instalado")
    );
}

#[test]
fn java_uses_the_wrapper_when_present_and_gradle_differs_from_maven() {
    let maven = project(&[("pom.xml", ""), ("mvnw", ""), ("src/test/java/A.java", "")]);
    let p = plan(maven.path(), &Fake::with(&["javac"]));
    assert_eq!(p.checks[0].command, "./mvnw -q -B test");
    assert_eq!(p.checks[1].command, "./mvnw -q -B -DskipTests package");
    let gradle = project(&[("build.gradle", "")]);
    let p = plan(gradle.path(), &Fake::with(&["gradle", "javac"]));
    assert_eq!(
        commands(&p),
        vec![(
            "java".into(),
            "build",
            "gradle -q build -x test".into(),
            false
        )]
    );
}

#[test]
fn the_project_declared_commands_replace_ours_for_the_labels_they_cover() {
    let dir = project(&[
        ("Cargo.toml", ""),
        ("tests/a.rs", ""),
        (
            ".hivecode/verify.json",
            r#"{"test":"make ci-test","typecheck":"  ","other":"x"}"#,
        ),
    ]);
    let p = plan(dir.path(), &Fake::with(&["cargo"]));
    assert_eq!(
        commands(&p),
        vec![
            ("declarado".into(), "pruebas", "make ci-test".into(), false),
            ("rust".into(), "build", "cargo build".into(), false)
        ],
        "tests come from the project, build from the ecosystem, the blank typecheck is ignored"
    );
    assert!(p.has_tests);
}

#[test]
fn an_unknown_project_gets_no_checks_and_a_makefile_alone_gets_make_test() {
    let unknown = project(&[("README.md", "hola")]);
    let p = plan(unknown.path(), &Fake::with(&["make", "cargo"]));
    assert!(p.ecosystems.is_empty() && p.checks.is_empty() && !p.has_tests);

    let make = project(&[("Makefile", "build:\n\techo\ntest:\n\techo ok\n")]);
    let p = plan(make.path(), &Fake::with(&["make"]));
    assert_eq!(
        commands(&p),
        vec![("make".into(), "pruebas", "make test".into(), false)]
    );
}

#[test]
fn dependency_dirs_are_not_crawled_and_an_empty_package_json_has_nothing_to_run() {
    let dir = project(&[
        ("package.json", "{}"),
        ("node_modules/x/test_a.py", ""),
        ("src/main.ts", ""),
    ]);
    let p = plan(dir.path(), &Fake::with(&["python3", "bun"]));
    assert_eq!(
        p.ecosystems,
        ["node"],
        "a .py file inside node_modules is not the project's"
    );
    assert!(p.checks.is_empty() && !p.has_tests);
    assert_eq!(detect(dir.path()), (vec!["node".to_owned()], false));
}

#[test]
fn node_runs_the_package_scripts_through_the_package_manager_the_lockfile_names() {
    let pkg = r#"{"scripts":{"test":"vitest run","build":"tsc -p ."}}"#;
    for (lock, manager, tests, build) in [
        ("bun.lock", "bun", "bun run test", "bun run build"),
        ("pnpm-lock.yaml", "pnpm", "pnpm run test", "pnpm run build"),
        ("yarn.lock", "yarn", "yarn test", "yarn build"),
        ("package-lock.json", "npm", "npm test", "npm run build"),
    ] {
        let dir = project(&[("package.json", pkg), (lock, "")]);
        let p = plan(dir.path(), &Fake::with(&[manager]));
        assert_eq!(
            commands(&p),
            vec![
                ("node".into(), "pruebas", tests.into(), false),
                ("node".into(), "build", build.into(), false)
            ],
            "{lock}"
        );
        assert!(p.has_tests);
    }
    // No lockfile: bun when it is installed, npm otherwise.
    let dir = project(&[("package.json", pkg)]);
    assert_eq!(
        plan(dir.path(), &Fake::with(&["bun"])).checks[0].command,
        "bun run test"
    );
    assert_eq!(
        plan(dir.path(), &Fake::with(&["npm"])).checks[0].command,
        "npm test"
    );
}

#[test]
fn test_files_without_a_test_script_run_with_bun_and_types_need_a_config_and_a_compiler() {
    let dir = project(&[
        ("package.json", "{}"),
        ("src/a.test.ts", ""),
        ("tsconfig.json", "{}"),
    ]);
    let p = plan(dir.path(), &Fake::with(&["bun"]));
    assert_eq!(
        commands(&p),
        vec![("node".into(), "pruebas", "bun test".into(), false)],
        "no compiler installed: no type check"
    );

    let with_compiler = project(&[
        ("package.json", "{}"),
        ("tsconfig.json", "{}"),
        ("node_modules/typescript/package.json", "{}"),
    ]);
    let p = plan(with_compiler.path(), &Fake::with(&["bun"]));
    assert_eq!(
        commands(&p),
        vec![("node".into(), "tipos", "bun tsc --noEmit".into(), false)]
    );

    let no_config = project(&[
        ("package.json", "{}"),
        ("node_modules/typescript/package.json", "{}"),
    ]);
    assert!(
        plan(no_config.path(), &Fake::with(&["bun"]))
            .checks
            .is_empty(),
        "tsc without a tsconfig says nothing"
    );
    let missing_bun = plan(dir.path(), &Fake::with(&[]));
    assert!(
        missing_bun.checks[0]
            .skip
            .as_deref()
            .unwrap()
            .contains("bun no está instalado")
    );
}

#[test]
fn declared_dependencies_that_are_not_installed_skip_the_check_instead_of_failing_it() {
    let pkg =
        r#"{"scripts":{"test":"vitest","build":"vite build"},"devDependencies":{"vitest":"1"}}"#;
    let bare = project(&[("package.json", pkg), ("bun.lock", "")]);
    let p = plan(bare.path(), &Fake::with(&["bun"]));
    assert_eq!(p.checks.len(), 2);
    assert!(
        p.checks.iter().all(|k| k.skip.as_deref().is_some_and(|s| s
            .contains("dependencias no están instaladas")
            && s.contains("bun install"))),
        "{p:?}"
    );
    let installed = project(&[
        ("package.json", pkg),
        ("bun.lock", ""),
        ("node_modules/vitest/package.json", "{}"),
    ]);
    assert!(
        plan(installed.path(), &Fake::with(&["bun"]))
            .checks
            .iter()
            .all(|k| k.skip.is_none())
    );
}

#[test]
fn the_project_declared_commands_still_win_over_the_node_ones() {
    let dir = project(&[
        ("package.json", r#"{"scripts":{"test":"vitest"}}"#),
        (".hivecode/verify.json", r#"{"test":"make probar"}"#),
    ]);
    let p = plan(dir.path(), &Fake::with(&["bun", "make"]));
    assert_eq!(
        commands(&p),
        vec![("declarado".into(), "pruebas", "make probar".into(), false)]
    );
}

#[tokio::test]
async fn running_a_check_reports_success_failure_timeout_and_skips() {
    let dir = tempfile::tempdir().unwrap();
    let mk = |command: &str, skip: Option<&str>| Check {
        ecosystem: "t".into(),
        label: Label::Tests,
        command: command.into(),
        skip: skip.map(Into::into),
    };
    let ok = run(
        &mk("echo hola && echo err 1>&2", None),
        dir.path(),
        Duration::from_secs(10),
        1000,
    )
    .await;
    assert!(
        ok.ok && ok.exit_code == Some(0) && ok.output.contains("hola") && ok.output.contains("err")
    );

    let bad = run(
        &mk("echo roto; exit 3", None),
        dir.path(),
        Duration::from_secs(10),
        1000,
    )
    .await;
    assert!(!bad.ok && bad.exit_code == Some(3) && bad.output.contains("roto"));

    let long = run(
        &mk("sleep 5", None),
        dir.path(),
        Duration::from_millis(200),
        1000,
    )
    .await;
    assert!(long.timed_out && !long.ok);

    let big = run(
        &mk("yes abcdefghij | head -c 5000", None),
        dir.path(),
        Duration::from_secs(10),
        100,
    )
    .await;
    assert!(
        big.output.starts_with("[...]") && big.output.len() <= 110,
        "only the tail is kept"
    );

    let skipped = run(
        &mk("echo no", Some("go no está instalado")),
        Path::new("."),
        Duration::from_secs(1),
        100,
    )
    .await;
    assert!(!skipped.ok && skipped.output.contains("skipped") && skipped.exit_code.is_none());
}

/// Prints the plan for a real project: `HIVECODE_VERIFY_DIR=/ruta cargo test -p hivecode-verify -- --ignored --nocapture`.
/// It only plans (and probes the PATH); it runs nothing.
#[test]
#[ignore = "needs HIVECODE_VERIFY_DIR"]
fn print_the_plan_of_a_real_project() {
    let dir = std::env::var("HIVECODE_VERIFY_DIR").expect("set HIVECODE_VERIFY_DIR");
    let plan = plan(Path::new(&dir), &hivecode_verify::RealEnv);
    println!(
        "ecosistemas: {:?}  has_tests: {}\n{}",
        plan.ecosystems,
        plan.has_tests,
        describe(&plan)
    );
}
