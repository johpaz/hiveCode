//! Git tools for the model (`git_status`, `git_diff`, `git_log`, `git_branch`, `git_commit`).
//!
//! Same names and result shapes as the TS tools in `packages/core/src/tools/code/index.ts`, with
//! two deliberate differences: they work only inside the project root (no `path` argument that
//! could point elsewhere) and `git_commit` takes `files` as a list, not a space-separated string.
use hive_agent_core::{Tool, provider::CancellationToken};
use hivecode_host::{BoxFuture, Result, ToolSet};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio};
use tokio::process::Command;

/// Output returned to the model is cut here, as the SDK tools do for theirs.
const MAX_OUTPUT: usize = 128 * 1024;

mod adr;
mod code_index;
mod mcp;
mod verify;
pub use adr::AdrTools;
pub use code_index::IndexTools;
pub use mcp::{McpTools, expand_env, load_config};
pub use verify::VerifyTools;

pub struct GitTools {
    root: PathBuf,
}

impl GitTools {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    async fn git(
        &self,
        args: &[&str],
        cancel: &CancellationToken,
    ) -> Result<(bool, String, String)> {
        let child = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot run git: {e}"))?;
        let output = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("cancelled".into()),
            output = child.wait_with_output() => output?,
        };
        Ok((
            output.status.success(),
            cut(&output.stdout),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }
}

fn cut(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_OUTPUT)]).into_owned();
    if bytes.len() > MAX_OUTPUT {
        format!("{text}\n[output truncated]")
    } else {
        text
    }
}

fn text<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

/// A ref or branch name that cannot be taken for an option.
fn plain_ref(value: &str) -> std::result::Result<&str, String> {
    if value.starts_with('-') || value.contains(['\0', '\n', ' ']) {
        Err(format!("invalid name: {value}"))
    } else {
        Ok(value)
    }
}

/// A path inside the project: relative, no `..`, no NUL.
fn inside(value: &str) -> std::result::Result<&str, String> {
    let bad = value.starts_with('/')
        || value.starts_with('-')
        || value.contains('\0')
        || value.split(['/', '\\']).any(|part| part == "..")
        || value.chars().nth(1) == Some(':');
    if bad {
        Err(format!("path must stay inside the project: {value}"))
    } else {
        Ok(value)
    }
}

fn fail(message: impl Into<String>) -> Value {
    json!({"ok": false, "error": message.into()})
}

impl ToolSet for GitTools {
    fn definitions(&self) -> Vec<Tool> {
        let tool = |name: &str, description: &str, parameters: Value| Tool {
            name: name.into(),
            description: description.into(),
            parameters,
            allow_repeated_results: false,
        };
        vec![
            tool(
                "git_status",
                "Show working tree status (git status --porcelain): changed, staged and untracked files.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            tool(
                "git_diff",
                "Show changes in the working tree or against a commit or branch (git diff).",
                json!({"type":"object","properties":{
                    "staged":{"type":"boolean","description":"Show staged changes (--cached)"},
                    "target":{"type":"string","maxLength":200,"description":"Compare against a branch or commit, e.g. main, HEAD~1"},
                    "file":{"type":"string","maxLength":4096,"description":"Only this file"}
                },"additionalProperties":false}),
            ),
            tool(
                "git_log",
                "Show commit history (git log), newest first.",
                json!({"type":"object","properties":{
                    "count":{"type":"integer","minimum":1,"maximum":200,"description":"Commits to show (default 10)"},
                    "branch":{"type":"string","maxLength":200}
                },"additionalProperties":false}),
            ),
            tool(
                "git_branch",
                "List, create, delete or switch git branches.",
                json!({"type":"object","properties":{
                    "action":{"type":"string","enum":["list","create","delete","switch"],"description":"Default: list"},
                    "name":{"type":"string","maxLength":200,"description":"Branch name for create, delete and switch"}
                },"additionalProperties":false}),
            ),
            tool(
                "git_commit",
                "Stage files and create a git commit.",
                json!({"type":"object","properties":{
                    "message":{"type":"string","minLength":1,"maxLength":4000},
                    "files":{"type":"array","items":{"type":"string","maxLength":4096},"maxItems":200,"description":"Files to stage; default: all changes"}
                },"required":["message"],"additionalProperties":false}),
            ),
        ]
    }

    fn mutates(&self, name: &str, arguments: &Value) -> bool {
        match name {
            "git_commit" => true,
            "git_branch" => text(arguments, "action").unwrap_or("list") != "list",
            _ => false,
        }
    }

    fn execute<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            Ok(match name {
                "git_status" => {
                    let (ok, out, err) = self.git(&["status", "--porcelain"], cancel).await?;
                    if !ok {
                        return Ok(
                            json!({"ok": false, "error": err, "hint": "Verify this is a git repository"}),
                        );
                    }
                    let lines: Vec<&str> = out.lines().filter(|l| !l.is_empty()).collect();
                    let slice = |l: &&str| l.get(3..).unwrap_or("").to_owned();
                    let staged: Vec<String> = lines
                        .iter()
                        .filter(|l| l.starts_with(['M', 'A', 'D', 'R', 'C']))
                        .map(slice)
                        .collect();
                    let unstaged: Vec<String> = lines
                        .iter()
                        .filter(|l| l.starts_with([' ', '?']) && !l.starts_with("  "))
                        .map(slice)
                        .collect();
                    json!({"ok": true, "result": {
                        "summary": format!("{} staged, {} unstaged/untracked", staged.len(), unstaged.len()),
                        "staged": staged, "unstaged": unstaged, "raw": out}})
                }
                "git_diff" => {
                    let mut args = vec!["diff"];
                    if arguments["staged"] == true {
                        args.push("--cached");
                    }
                    if let Some(target) = text(&arguments, "target") {
                        match plain_ref(target) {
                            Ok(t) => args.push(t),
                            Err(e) => return Ok(fail(e)),
                        }
                    }
                    args.push("--");
                    if let Some(file) = text(&arguments, "file") {
                        match inside(file) {
                            Ok(f) => args.push(f),
                            Err(e) => return Ok(fail(e)),
                        }
                    }
                    let (ok, out, err) = self.git(&args, cancel).await?;
                    if ok {
                        json!({"ok": true, "result": {"diff": out, "length": out.len()}})
                    } else {
                        fail(err)
                    }
                }
                "git_log" => {
                    let count = arguments["count"]
                        .as_u64()
                        .unwrap_or(10)
                        .clamp(1, 200)
                        .to_string();
                    let max = format!("--max-count={count}");
                    let mut args = vec!["log", &max, "--format=%h%x09%ai%x09%an%x09%s"];
                    if let Some(branch) = text(&arguments, "branch") {
                        match plain_ref(branch) {
                            Ok(b) => args.push(b),
                            Err(e) => return Ok(fail(e)),
                        }
                    }
                    args.push("--");
                    let (ok, out, err) = self.git(&args, cancel).await?;
                    if !ok {
                        return Ok(fail(err));
                    }
                    let commits: Vec<Value> = out
                        .lines()
                        .filter_map(|l| {
                            let mut f = l.splitn(4, '\t');
                            Some(json!({"hash": f.next()?, "date": f.next()?, "author": f.next()?, "message": f.next()?}))
                        })
                        .collect();
                    json!({"ok": true, "result": {"count": commits.len(), "commits": commits}})
                }
                "git_branch" => {
                    let action = text(&arguments, "action").unwrap_or("list");
                    if action == "list" {
                        let (ok, out, err) = self.git(&["branch", "-a"], cancel).await?;
                        if !ok {
                            return Ok(fail(err));
                        }
                        let branches: Vec<String> = out
                            .lines()
                            .map(|b| b.trim().to_owned())
                            .filter(|b| !b.is_empty())
                            .collect();
                        let current = branches
                            .iter()
                            .find_map(|b| b.strip_prefix("* "))
                            .map(str::to_owned);
                        return Ok(
                            json!({"ok": true, "result": {"branches": branches, "current": current}}),
                        );
                    }
                    let Some(branch) = text(&arguments, "name") else {
                        return Ok(fail("Invalid action or missing branch name"));
                    };
                    let branch = match plain_ref(branch) {
                        Ok(b) => b,
                        Err(e) => return Ok(fail(e)),
                    };
                    let (args, done): (Vec<&str>, String) = match action {
                        "create" => (vec!["branch", branch], format!("Branch '{branch}' created")),
                        "delete" => (
                            vec!["branch", "-d", branch],
                            format!("Branch '{branch}' deleted"),
                        ),
                        "switch" => (
                            vec!["checkout", branch],
                            format!("Switched to branch '{branch}'"),
                        ),
                        _ => return Ok(fail("Invalid action or missing branch name")),
                    };
                    let (ok, _, err) = self.git(&args, cancel).await?;
                    if ok {
                        json!({"ok": true, "result": done})
                    } else if action == "delete" {
                        json!({"ok": false, "error": err, "hint": "The branch may not be merged; a forced delete needs the person's approval"})
                    } else {
                        fail(err)
                    }
                }
                "git_commit" => {
                    let Some(message) = text(&arguments, "message") else {
                        return Ok(fail("Commit message is required"));
                    };
                    let mut add = vec!["add"];
                    let files: Vec<&str> = arguments["files"]
                        .as_array()
                        .map(|f| f.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    if files.is_empty() {
                        add.push("-A");
                    } else {
                        add.push("--");
                        for file in &files {
                            if let Err(e) = inside(file) {
                                return Ok(fail(e));
                            }
                            add.push(file);
                        }
                    }
                    let (ok, _, err) = self.git(&add, cancel).await?;
                    if !ok {
                        return Ok(fail(err));
                    }
                    let (ok, out, err) = self.git(&["commit", "-m", message], cancel).await?;
                    if ok {
                        json!({"ok": true, "result": {"message": out.trim()}})
                    } else {
                        fail(if err.trim().is_empty() { out } else { err })
                    }
                }
                other => fail(format!("unknown git tool: {other}")),
            })
        })
    }
}
