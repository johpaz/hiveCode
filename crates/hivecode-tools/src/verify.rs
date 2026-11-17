//! `verify_plan` and `verify_run`: how this project is built and tested, and running it.
//!
//! The TS version has one tool per check (`code_build`, `code_test`, `code_lint`, `check_types`)
//! that each rediscover the project. Here the ecosystem is recognised once (`hivecode-verify`) and
//! the model asks for the check by label. Running one executes the project's own command (or the
//! one in its `.hivecode/verify.json`), so `verify_run` counts as a mutating tool: `plan` refuses
//! it and `approval` asks first.
use hive_agent_core::{Tool, provider::CancellationToken};
use hivecode_host::{BoxFuture, Result, ToolSet};
use hivecode_verify::{Label, RealEnv};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};

const DEFAULT_TIMEOUT_MS: u64 = 300_000;
const MAX_TIMEOUT_MS: u64 = 1_800_000;
const MAX_OUTPUT: usize = 24 * 1024;

pub struct VerifyTools {
    root: PathBuf,
}
impl VerifyTools {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

impl ToolSet for VerifyTools {
    fn definitions(&self) -> Vec<Tool> {
        vec![
            Tool {
                name: "verify_plan".into(),
                description: "Recognise the project's ecosystem(s) and list how it is tested, built and type-checked, and which checks cannot run here and why. Runs nothing.".into(),
                parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
                allow_repeated_results: false,
            },
            Tool {
                name: "verify_run".into(),
                description: "Run one planned check of the project: label `pruebas` (tests), `build` or `tipos` (type check). Use verify_plan first to see what exists.".into(),
                parameters: json!({"type":"object","properties":{
                    "label":{"type":"string","enum":["pruebas","build","tipos"]},
                    "timeout_ms":{"type":"integer","minimum":1000,"maximum":MAX_TIMEOUT_MS}
                },"required":["label"],"additionalProperties":false}),
                // A rerun after a fix has the same arguments and may well have a different result.
                allow_repeated_results: true,
            },
        ]
    }

    fn mutates(&self, name: &str, _: &Value) -> bool {
        name == "verify_run"
    }

    fn execute<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let root = self.root.clone();
            let plan =
                tokio::task::spawn_blocking(move || hivecode_verify::plan(&root, &RealEnv)).await?;
            if name == "verify_plan" {
                let checks: Vec<Value> = plan
                    .checks
                    .iter()
                    .map(|k| json!({"ecosystem": k.ecosystem, "label": k.label.as_str(), "command": k.command, "skipped": k.skip}))
                    .collect();
                return Ok(json!({"ok": true, "result": {
                    "ecosystems": plan.ecosystems, "has_tests": plan.has_tests, "checks": checks}}));
            }
            let Some(label) = arguments["label"].as_str().and_then(Label::parse) else {
                return Ok(json!({"ok": false, "error": "label must be pruebas, build or tipos"}));
            };
            let timeout = arguments["timeout_ms"]
                .as_u64()
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .min(MAX_TIMEOUT_MS);
            let selected: Vec<_> = plan.checks.iter().filter(|k| k.label == label).collect();
            if selected.is_empty() {
                return Ok(json!({"ok": false, "error": format!(
                    "this project has no `{}` check; verify_plan lists what exists", label.as_str())}));
            }
            let mut results = vec![];
            let mut all_ok = true;
            for check in selected {
                let outcome = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("cancelled".into()),
                    outcome = hivecode_verify::run(check, &self.root, Duration::from_millis(timeout), MAX_OUTPUT) => outcome,
                };
                // A check that does not apply here is reported, and is not a failure of the code.
                if check.skip.is_none() {
                    all_ok &= outcome.ok;
                }
                results.push(json!({
                    "ecosystem": check.ecosystem, "command": check.command, "skipped": check.skip,
                    "passed": outcome.ok, "exit_code": outcome.exit_code,
                    "timed_out": outcome.timed_out, "output": outcome.output}));
            }
            Ok(
                json!({"ok": true, "result": {"label": label.as_str(), "passed": all_ok, "checks": results}}),
            )
        })
    }
}
