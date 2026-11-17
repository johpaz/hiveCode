use hive_agent_core::provider::CancellationToken;
use hivecode_host::ToolSet;
use hivecode_tools::GitTools;
use serde_json::{Value, json};
use std::{path::Path, process::Command};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    // git_commit runs plain `git commit`, so the repository needs its own identity.
    git(dir.path(), &["config", "user.name", "t"]);
    git(dir.path(), &["config", "user.email", "t@t"]);
    git(dir.path(), &["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.path().join("a.txt"), "uno\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-q", "-m", "init"]);
    dir
}
async fn call(tools: &GitTools, name: &str, args: Value) -> Value {
    tools
        .execute(name, args, &CancellationToken::new())
        .await
        .unwrap()
}

#[tokio::test]
async fn status_diff_log_and_commit_work_on_a_real_repository() {
    let dir = repo();
    let tools = GitTools::new(dir.path());
    std::fs::write(dir.path().join("a.txt"), "uno\ndos\n").unwrap();
    std::fs::write(dir.path().join("nuevo.txt"), "x\n").unwrap();

    let status = call(&tools, "git_status", json!({})).await;
    assert_eq!(status["ok"], true);
    assert_eq!(
        status["result"]["summary"],
        "0 staged, 2 unstaged/untracked"
    );

    let diff = call(&tools, "git_diff", json!({"file": "a.txt"})).await;
    assert!(diff["result"]["diff"].as_str().unwrap().contains("+dos"));

    let commit = call(
        &tools,
        "git_commit",
        json!({"message": "agrega dos", "files": ["a.txt"]}),
    )
    .await;
    assert_eq!(commit["ok"], true, "{commit}");
    let log = call(&tools, "git_log", json!({"count": 5})).await;
    assert_eq!(log["result"]["count"], 2);
    assert_eq!(log["result"]["commits"][0]["message"], "agrega dos");
    // Only the listed file was staged: the untracked one is still untracked.
    let status = call(&tools, "git_status", json!({})).await;
    assert_eq!(status["result"]["unstaged"], json!(["nuevo.txt"]));
}

#[tokio::test]
async fn branches_can_be_listed_created_switched_and_deleted() {
    let dir = repo();
    let tools = GitTools::new(dir.path());
    assert_eq!(
        call(
            &tools,
            "git_branch",
            json!({"action": "create", "name": "feat"})
        )
        .await["ok"],
        true
    );
    assert_eq!(
        call(
            &tools,
            "git_branch",
            json!({"action": "switch", "name": "feat"})
        )
        .await["ok"],
        true
    );
    let list = call(&tools, "git_branch", json!({})).await;
    assert_eq!(list["result"]["current"], "feat");
    assert_eq!(
        call(
            &tools,
            "git_branch",
            json!({"action": "switch", "name": "main"})
        )
        .await["ok"],
        true
    );
    assert_eq!(
        call(
            &tools,
            "git_branch",
            json!({"action": "delete", "name": "feat"})
        )
        .await["ok"],
        true
    );
}

#[tokio::test]
async fn arguments_that_could_act_as_options_or_leave_the_project_are_refused() {
    let dir = repo();
    let tools = GitTools::new(dir.path());
    for (name, args) in [
        ("git_diff", json!({"target": "--output=/tmp/x"})),
        ("git_diff", json!({"file": "../fuera"})),
        ("git_diff", json!({"file": "/etc/passwd"})),
        ("git_log", json!({"branch": "--all"})),
        ("git_branch", json!({"action": "create", "name": "-D"})),
        (
            "git_commit",
            json!({"message": "x", "files": ["../secreto"]}),
        ),
    ] {
        let result = call(&tools, name, args.clone()).await;
        assert_eq!(result["ok"], false, "{name} {args}");
    }
}

#[test]
fn only_changing_calls_are_flagged_as_mutating() {
    let tools = GitTools::new(".");
    for (name, args, expected) in [
        ("git_status", json!({}), false),
        ("git_diff", json!({}), false),
        ("git_log", json!({}), false),
        ("git_branch", json!({}), false),
        ("git_branch", json!({"action": "list"}), false),
        ("git_branch", json!({"action": "create", "name": "x"}), true),
        ("git_commit", json!({"message": "x"}), true),
    ] {
        assert_eq!(tools.mutates(name, &args), expected, "{name} {args}");
    }
}

mod verify {
    use super::*;
    use hivecode_tools::VerifyTools;

    #[tokio::test]
    async fn the_plan_lists_checks_and_a_run_reports_pass_and_fail_from_the_projects_own_commands()
    {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".hivecode")).unwrap();
        std::fs::write(
            dir.path().join(".hivecode/verify.json"),
            r#"{"test":"echo todo bien","build":"echo roto >&2; exit 2"}"#,
        )
        .unwrap();
        let tools = VerifyTools::new(dir.path());
        let cancel = CancellationToken::new();

        let plan = tools
            .execute("verify_plan", json!({}), &cancel)
            .await
            .unwrap();
        assert_eq!(plan["result"]["checks"].as_array().unwrap().len(), 2);

        let tests = tools
            .execute("verify_run", json!({"label": "pruebas"}), &cancel)
            .await
            .unwrap();
        assert_eq!(tests["result"]["passed"], true);
        assert!(
            tests["result"]["checks"][0]["output"]
                .as_str()
                .unwrap()
                .contains("todo bien")
        );

        let build = tools
            .execute("verify_run", json!({"label": "build"}), &cancel)
            .await
            .unwrap();
        assert_eq!(build["ok"], true, "the tool worked; the code did not pass");
        assert_eq!(build["result"]["passed"], false);
        assert_eq!(build["result"]["checks"][0]["exit_code"], 2);

        let missing = tools
            .execute("verify_run", json!({"label": "tipos"}), &cancel)
            .await
            .unwrap();
        assert_eq!(missing["ok"], false);
    }

    #[test]
    fn only_running_a_check_counts_as_mutating() {
        let tools = VerifyTools::new(".");
        assert!(!tools.mutates("verify_plan", &json!({})));
        assert!(tools.mutates("verify_run", &json!({"label": "pruebas"})));
    }
}

mod code_index {
    use super::*;
    use hivecode_tools::IndexTools;

    #[tokio::test(flavor = "multi_thread")]
    async fn the_four_index_tools_answer_from_the_project_and_notice_edits() {
        let dir = tempfile::tempdir().unwrap();
        for (path, content) in [
            ("src/store.ts", "export class Store {\n  load() {}\n}\n"),
            (
                "src/app.ts",
                "import { Store } from './store'\nexport function run() {}\n",
            ),
            ("src/store.test.ts", "import { Store } from './store'\n"),
        ] {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, content).unwrap();
        }
        let tools = IndexTools::new(dir.path());
        let cancel = CancellationToken::new();
        let ask = |name: &'static str, args: Value| {
            let (tools, cancel) = (&tools, &cancel);
            async move { tools.execute(name, args, cancel).await.unwrap() }
        };

        let outline = ask("outline", json!({"path": "src/store.ts"})).await;
        assert_eq!(outline["symbols"][0]["name"], "Store");
        assert_eq!(outline["symbols"][1]["lines"], "2-2");
        assert_eq!(outline["stale"], false);

        let found = ask("find_symbol", json!({"name": "load"})).await;
        assert_eq!(found["total"], 1);
        assert_eq!(found["matches"][0]["path"], "src/store.ts");

        let deps = ask("dependents", json!({"path": "src/store.ts"})).await;
        assert_eq!(
            deps["imported_by"],
            json!(["src/app.ts", "src/store.test.ts"])
        );

        let tests = ask("tests_for", json!({"path": "src/store.ts"})).await;
        assert_eq!(tests["tests"], json!(["src/store.test.ts"]));
        let covers = ask("tests_for", json!({"path": "src/store.test.ts"})).await;
        assert_eq!(covers["kind"], "test");
        assert_eq!(covers["covers"], json!(["src/store.ts"]));

        assert_eq!(
            ask("outline", json!({"path": "src/nada.ts"})).await["ok"],
            false
        );
        assert_eq!(ask("find_symbol", json!({"name": "zzz"})).await["total"], 0);

        // An edit shows up on the next question without anyone asking for a re-index.
        std::fs::write(
            dir.path().join("src/store.ts"),
            "export class Store {\n  load() {}\n}\nexport function nueva() {}\n",
        )
        .unwrap();
        assert_eq!(
            ask("find_symbol", json!({"name": "nueva"})).await["total"],
            1
        );
    }

    #[test]
    fn index_tools_never_count_as_mutating() {
        let tools = IndexTools::new(".");
        assert!(
            ["outline", "find_symbol", "dependents", "tests_for"]
                .iter()
                .all(|n| !tools.mutates(n, &json!({})))
        );
    }
}

mod mcp {
    use super::*;
    use hivecode_tools::{McpTools, expand_env, load_config};

    fn peer(mode: &str) -> Value {
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_peer.py");
        json!({"command": "python3", "args": [script, mode], "timeout_ms": 3000})
    }

    #[test]
    fn env_references_expand_and_a_missing_one_is_an_error_not_an_empty_credential() {
        let env = |n: &str| (n == "TOKEN").then(|| "s3cr3t".to_owned());
        assert_eq!(
            expand_env("Bearer ${TOKEN}!", &env).unwrap(),
            "Bearer s3cr3t!"
        );
        assert!(expand_env("${NOPE}", &env).unwrap_err().contains("NOPE"));
        assert!(expand_env("${open", &env).is_err());

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        assert_eq!(
            load_config(&file, &env).unwrap(),
            json!({}),
            "no file means no servers"
        );
        std::fs::write(
            &file,
            r#"{"servers":{"s":{"command":"x","env":{"K":"${TOKEN}"}}}}"#,
        )
        .unwrap();
        assert_eq!(load_config(&file, &env).unwrap()["s"]["env"]["K"], "s3cr3t");
        std::fs::write(
            &file,
            r#"{"servers":{"s":{"command":"x","env":{"K":"${NOPE}"}}}}"#,
        )
        .unwrap();
        assert!(load_config(&file, &env).unwrap_err().contains("server `s`"));
        std::fs::write(&file, r#"[]"#).unwrap();
        assert!(load_config(&file, &env).is_err());
    }

    #[tokio::test]
    async fn a_server_tool_is_offered_qualified_called_and_always_counts_as_mutating() {
        let (tools, report) = McpTools::connect(json!({"math": peer("normal")}))
            .await
            .unwrap();
        assert_eq!(report["failed"], json!({}));
        let defs = tools.definitions();
        assert_eq!(
            defs.len(),
            1,
            "the tool whose name cannot be a wire name is left out"
        );
        assert_eq!(defs[0].name, "math__add");
        assert!(defs[0].parameters.get("$schema").is_none());
        assert!(tools.mutates("math__add", &json!({})));

        let cancel = CancellationToken::new();
        let ok = tools
            .execute("math__add", json!({"a": 2, "b": 3}), &cancel)
            .await
            .unwrap();
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["result"]["content"][0]["text"], "5");
        let unknown = tools
            .execute("math__nope", json!({}), &cancel)
            .await
            .unwrap();
        assert_eq!(unknown["ok"], false);
        tools.close().await;
    }

    #[tokio::test]
    async fn tool_errors_and_a_lost_connection_are_told_apart_and_the_latter_is_not_retried() {
        let cancel = CancellationToken::new();
        let (errs, _) = McpTools::connect(json!({"s": peer("error")}))
            .await
            .unwrap();
        let failed = errs
            .execute("s__add", json!({"a": 1, "b": 1}), &cancel)
            .await
            .unwrap();
        assert_eq!(failed["ok"], false, "{failed}");
        assert_eq!(failed["result"]["error"]["code"], "MCP_TOOL_ERROR");
        assert!(
            failed.to_string().contains("no se pudo"),
            "the server's own message reaches the model"
        );
        errs.close().await;

        let (dying, _) = McpTools::connect(json!({"s": peer("exit")})).await.unwrap();
        let lost = dying
            .execute("s__add", json!({"a": 1, "b": 1}), &cancel)
            .await
            .unwrap();
        assert!(
            lost["error"]
                .as_str()
                .unwrap()
                .contains("MCP_OPERATION_UNCERTAIN"),
            "{lost}"
        );
        let again = dying
            .execute("s__add", json!({"a": 1, "b": 1}), &cancel)
            .await
            .unwrap();
        assert_eq!(again["ok"], false);
        assert!(
            again["error"]
                .as_str()
                .unwrap()
                .contains("MCP_SERVER_UNAVAILABLE"),
            "the second call sends nothing: {again}"
        );
        dying.close().await;
    }

    #[tokio::test]
    async fn a_server_that_does_not_connect_is_reported_and_the_others_still_work() {
        let (tools, report) = McpTools::connect(json!({
            "good": peer("normal"),
            "bad": {"command": "/no/existe/mcp", "timeout_ms": 1000}
        }))
        .await
        .unwrap();
        assert!(report["failed"]["bad"].is_string());
        assert_eq!(tools.definitions()[0].name, "good__add");
        tools.close().await;
    }
}

mod adr_tools {
    use super::*;
    use hivecode_tools::AdrTools;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("adrs")).unwrap();
        std::fs::write(
            dir.path().join("adrs/0001-autenticacion.md"),
            "# Autenticación\n\n**Status**: accepted\nLos permisos viven en la carpeta auth.\n",
        )
        .unwrap();
        dir
    }

    #[tokio::test]
    async fn adr_check_rates_files_and_adr_search_finds_decisions() {
        let dir = project();
        let tools = AdrTools::new(dir.path());
        let cancel = CancellationToken::new();
        let checked = tools
            .execute(
                "adr_check",
                json!({"paths": ["src/auth/login.ts", "README.md", "db/schema.sql"]}),
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(checked["ok"], true);
        let risk = |i: usize| checked["files"][i]["risk"].as_str().unwrap().to_owned();
        assert_eq!(
            (risk(0), risk(1), risk(2)),
            ("high".into(), "low".into(), "high".into())
        );
        assert_eq!(checked["files"][0]["adr"], "adrs/0001-autenticacion.md");
        assert!(
            checked["files"][0]["reason"]
                .as_str()
                .unwrap()
                .contains("Autenticación")
        );

        let found = tools
            .execute("adr_search", json!({"query": "permisos"}), &cancel)
            .await
            .unwrap();
        assert_eq!(found["matches"][0]["title"], "Autenticación");
        assert_eq!(found["matches"][0]["status"], "accepted");
        assert_eq!(found["total_adrs"], 1);

        let escape = tools
            .execute("adr_check", json!({"paths": ["../fuera"]}), &cancel)
            .await
            .unwrap();
        assert_eq!(escape["ok"], false);
        let none = AdrTools::new(tempfile::tempdir().unwrap().path())
            .execute("adr_check", json!({"paths": ["a.rs"]}), &cancel)
            .await
            .unwrap();
        assert!(none["note"].as_str().unwrap().contains("no adrs/ folder"));
        assert!(
            !tools.mutates("adr_check", &json!({})) && !tools.mutates("adr_search", &json!({}))
        );
    }
}
