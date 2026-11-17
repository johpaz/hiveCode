//! The deterministic verification: run the project (port of `harness/deterministic-checks.ts`).
//!
//! A model gate costs minutes and judges; running the suite costs seconds and measures. Three
//! states, not two: passed, failed and *nothing to check*. A project without tests is not a project
//! with broken tests: that would be an invented failure, and an invented failure triggers repairs
//! that fix nothing.
use hivecode_verify::{Check, Label, RealEnv};
use regex::Regex;
use std::{path::Path, sync::LazyLock, time::Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone)]
pub struct Result {
    pub name: String,
    pub status: Status,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct Verdict {
    pub ok: bool,
    pub checks: Vec<Result>,
    pub summary: String,
}

/// What a test runner prints when it found nothing to run: not a failure.
static NO_TESTS_RAN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)Ran 0 tests|NO TESTS RAN|no tests ran|collected 0 items|No tests were found|running 0 tests|0 tests? (?:passed|run)").unwrap()
});

const TIMEOUT: Duration = Duration::from_secs(300);
const DETAIL_CHARS: usize = 800;

/// The checks this project has, for the agent to know what the harness will do at the end.
pub async fn planned(workspace: &Path) -> Vec<Check> {
    let dir = workspace.to_path_buf();
    tokio::task::spawn_blocking(move || hivecode_verify::plan(&dir, &RealEnv).checks)
        .await
        .unwrap_or_default()
}

pub async fn verify(workspace: &Path) -> Verdict {
    let mut checks = vec![];
    for check in planned(workspace).await {
        let name = check.label.as_str().to_owned();
        // Not applicable here (a toolchain that is not installed): said, never a failure.
        if let Some(why) = &check.skip {
            checks.push(Result {
                name,
                status: Status::Skipped,
                detail: why.clone(),
            });
            continue;
        }
        let outcome = hivecode_verify::run(&check, workspace, TIMEOUT, DETAIL_CHARS).await;
        // A type check that exits non-zero without a single `error TS` did not run the compiler (it is
        // not installed or could not start): that is the environment, not a type error.
        let compiler_did_not_run = check.ecosystem == "node"
            && check.label == Label::Types
            && !outcome.output.contains("error TS");
        let status = if outcome.ok {
            Status::Passed
        } else if (check.label == Label::Tests && NO_TESTS_RAN.is_match(&outcome.output))
            || compiler_did_not_run
        {
            Status::Skipped
        } else {
            Status::Failed
        };
        let detail = match status {
            Status::Passed => String::new(),
            Status::Skipped if compiler_did_not_run => {
                format!(
                    "tsc no pudo ejecutarse: {}",
                    outcome.output.lines().next().unwrap_or("sin salida")
                )
            }
            Status::Skipped if outcome.exit_code.is_none() && !outcome.timed_out => outcome.output,
            Status::Skipped => "no había nada que comprobar".to_owned(),
            Status::Failed => outcome.output,
        };
        checks.push(Result {
            name,
            status,
            detail,
        });
    }
    let summary = checks
        .iter()
        .map(|c| {
            let mark = match c.status {
                Status::Passed => "✓",
                Status::Failed => "✗",
                Status::Skipped => "—",
            };
            format!("{} {mark}", c.name)
        })
        .collect::<Vec<_>>()
        .join(" · ");
    Verdict {
        ok: checks.iter().all(|c| c.status != Status::Failed),
        checks,
        summary,
    }
}

/// The text for the report and the answer to the person.
pub fn describe(verdict: &Verdict) -> String {
    let lines: Vec<String> = verdict
        .checks
        .iter()
        .map(|c| {
            let (mark, show) = match c.status {
                Status::Passed => ("✓", false),
                Status::Failed => ("✗", true),
                Status::Skipped => ("—", true),
            };
            if show && !c.detail.is_empty() {
                format!("- {} {mark}: {}", c.name, c.detail)
            } else {
                format!("- {} {mark}", c.name)
            }
        })
        .collect();
    format!(
        "Verificación determinista: {}\n{}",
        if verdict.ok {
            "todo en verde"
        } else {
            "hay comprobaciones en rojo"
        },
        lines.join("\n")
    )
}
