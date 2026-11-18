//! Per-task git worktrees (port of `packages/code/src/workspace/manager.ts`).
//!
//! A task that changes files works in its own `git worktree`, seeded with whatever the project
//! currently has (tracked edits and untracked files), so the task's diff is exactly its own work.
//! The diff is taken against a *baseline* commit recorded under `refs/hivecode/baselines/`, then
//! applied back to the project with `git apply --3way`. Nothing here talks to a model.
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub workspace_id: String,
    pub task_id: String,
    pub project: PathBuf,
    pub worktree: PathBuf,
    pub branch: String,
    pub baseline_ref: Option<String>,
    pub isolated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Integration {
    Integrated { diff: String },
    Noop,
    Conflict { diff: String, error: String },
    Failed { error: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskWorktree {
    pub path: PathBuf,
    pub branch: String,
    pub task_slug: String,
    /// Work that was never integrated into the project.
    pub has_changes: bool,
}

/// Lowercase, `[a-z0-9._-]` only, at most 80 characters; never empty.
pub fn slug(value: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(80).collect();
    if trimmed.is_empty() {
        "task".into()
    } else {
        trimmed
    }
}

/// Untracked files no task should leave in the project: tool backups, installed dependencies, the
/// scratch agents create to check their own work and the caches that running tests leaves. Only untracked files are filtered.
pub fn is_noise(file: &str) -> bool {
    let parts: Vec<&str> = file.split('/').collect();
    let name = parts.last().copied().unwrap_or("");
    let backup = name
        .rsplit_once(".hive-bak.")
        .is_some_and(|(_, ts)| !ts.is_empty() && ts.chars().all(|c| c.is_ascii_digit()));
    backup
        || parts.contains(&"node_modules")
        || parts[..parts.len().saturating_sub(1)].iter().any(|p| {
            matches!(
                *p,
                ".qg" | ".smoke" | ".scratch" | ".tmp" | ".cache"
                // What running a project's own tests leaves behind: found by a real run, where the
                // agent's `python3 -m unittest` put `__pycache__/*.pyc` in the integrated patch.
                | "__pycache__" | ".pytest_cache" | ".mypy_cache" | ".ruff_cache"
            )
        })
        || name.ends_with(".pyc")
        || name == ".DS_Store"
        || matches!(name, ".qg" | ".smoke" | ".scratch" | ".tmp" | ".cache")
        || name.starts_with(".verify-")
        || file.ends_with(".log")
}

/// A temp file name no other patch in this process (or another one) can share: two integrations
/// of the same task id at once must never overwrite or delete each other's patch.
fn patch_path(prefix: &str, task_id: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{}-{n}.patch",
        slug(task_id),
        std::process::id()
    ))
}

struct Out {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}
impl Out {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    fn message(&self) -> String {
        let err = self.stderr.trim();
        if err.is_empty() {
            let out = self.text();
            if out.trim().is_empty() {
                "unknown error".into()
            } else {
                out
            }
        } else {
            err.to_owned()
        }
    }
}

async fn git(cwd: &Path, args: &[&str]) -> Result<Out> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("cannot run git: {e}"))?;
    Ok(Out {
        ok: output.status.success(),
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}
async fn git_ok(cwd: &Path, args: &[&str], what: &str) -> Result<Out> {
    let out = git(cwd, args).await?;
    if out.ok {
        Ok(out)
    } else {
        Err(format!("{what}: {}", out.message()).into())
    }
}

pub struct Workspaces {
    root: PathBuf,
}

impl Workspaces {
    /// `root` is where worktrees live; the TS version uses `<tmp>/hivecode-worktrees`.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn in_temp_dir() -> Self {
        Self::new(std::env::temp_dir().join("hivecode-worktrees"))
    }

    pub fn assignment(&self, task_id: &str, project: &Path, mutating: bool) -> Assignment {
        let task_slug = slug(task_id);
        if !mutating {
            return Assignment {
                workspace_id: format!("base:{task_slug}"),
                task_id: task_id.into(),
                project: project.into(),
                worktree: project.into(),
                branch: "HEAD".into(),
                baseline_ref: None,
                isolated: false,
            };
        }
        Assignment {
            workspace_id: format!("worktree:{task_slug}"),
            task_id: task_id.into(),
            project: project.into(),
            worktree: self.root.join(&task_slug),
            branch: format!("hivecode/task-{task_slug}"),
            baseline_ref: Some(format!("refs/hivecode/baselines/{task_slug}")),
            isolated: true,
        }
    }

    /// A private copy for one swarm instance (`builder#2`) of a task: branch `hivecode/swarm-…`.
    /// `project` is the task's own worktree, so the instance's work merges back into it, not into
    /// the person's project.
    pub fn swarm_assignment(&self, task_id: &str, instance: &str, project: &Path) -> Assignment {
        let key = slug(&format!("{task_id}-{instance}"));
        Assignment {
            workspace_id: format!("swarm:{key}"),
            task_id: format!("swarm-{key}"),
            project: project.into(),
            worktree: self.root.join(format!("swarm-{key}")),
            branch: format!("hivecode/swarm-{key}"),
            baseline_ref: Some(format!("refs/hivecode/baselines/swarm-{key}")),
            isolated: true,
        }
    }

    pub async fn prepare(&self, a: &Assignment, base_ref: &str) -> Result<()> {
        if !a.isolated {
            return Ok(());
        }
        std::fs::create_dir_all(&self.root)?;
        let worktree = a.worktree.to_string_lossy();
        git_ok(
            &a.project,
            &["worktree", "add", "-B", &a.branch, &worktree, base_ref],
            "Failed to create worktree",
        )
        .await?;
        self.seed_baseline(a, base_ref).await
    }

    /// The task's own changes, as a binary-safe patch against its baseline.
    pub async fn diff(&self, a: &Assignment) -> Result<String> {
        if !a.isolated {
            return Ok(String::new());
        }
        let untracked = git(
            &a.worktree,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )
        .await?;
        if untracked.ok {
            let text = untracked.text();
            let files: Vec<&str> = text
                .split('\0')
                .filter(|f| !f.is_empty() && !is_noise(f))
                .collect();
            if !files.is_empty() {
                let mut args = vec!["add", "-N", "--"];
                args.extend(files);
                git(&a.worktree, &args).await?;
            }
        }
        let base = a.baseline_ref.as_deref().unwrap_or("HEAD");
        let diff = git_ok(
            &a.worktree,
            &["diff", "--binary", base, "--"],
            "Failed to diff worktree",
        )
        .await?;
        Ok(diff.text())
    }

    pub async fn integrate(&self, a: &Assignment) -> Integration {
        if !a.isolated {
            return Integration::Noop;
        }
        let diff = match self.diff(a).await {
            Ok(diff) => diff,
            Err(e) => {
                return Integration::Failed {
                    error: e.to_string(),
                };
            }
        };
        if diff.trim().is_empty() {
            return Integration::Noop;
        }
        let patch = patch_path("hivecode", &a.task_id);
        if let Err(e) = std::fs::write(&patch, &diff) {
            return Integration::Failed {
                error: e.to_string(),
            };
        }
        let patch_arg = patch.to_string_lossy().into_owned();
        let result = async {
            let three_way = git(
                &a.project,
                &["apply", "--3way", "--whitespace=nowarn", &patch_arg],
            )
            .await?;
            if three_way.ok {
                return Ok(Integration::Integrated { diff: diff.clone() });
            }
            // `--3way` needs every touched file in the index; a file the project has but git does
            // not track yet is not there. The baseline already holds it, so a plain apply is exact
            // (and all-or-nothing, so it cannot half-apply).
            let plain = git(&a.project, &["apply", "--whitespace=nowarn", &patch_arg]).await?;
            if plain.ok {
                return Ok(Integration::Integrated { diff: diff.clone() });
            }
            let error = three_way.message();
            let lower = error.to_lowercase();
            Ok::<_, Error>(
                if lower.contains("conflict")
                    || lower.contains("patch does not apply")
                    || lower.contains("failed")
                {
                    Integration::Conflict {
                        diff: diff.clone(),
                        error,
                    }
                } else {
                    Integration::Failed { error }
                },
            )
        }
        .await;
        let _ = std::fs::remove_file(&patch);
        result.unwrap_or_else(|e| Integration::Failed {
            error: e.to_string(),
        })
    }

    /// Undoes a patch that was integrated into `project`: the reverse of `diff`, all or nothing. It is
    /// checked first, so a project that changed in the meantime (so the patch no longer fits back
    /// cleanly) is refused and left untouched instead of half-reverted.
    pub async fn revert(&self, project: &Path, diff: &str) -> Result<()> {
        let patch = patch_path("hivecode-revert", "rollback");
        std::fs::write(&patch, diff)?;
        let arg = patch.to_string_lossy().into_owned();
        let result = async {
            let check = git(project, &["apply", "-R", "--check", "--whitespace=nowarn", &arg]).await?;
            if !check.ok {
                return Err(format!(
                    "the project changed since this run, so its changes cannot be undone cleanly: {}",
                    check.message()
                )
                .into());
            }
            git_ok(project, &["apply", "-R", "--whitespace=nowarn", &arg], "Failed to revert").await?;
            Ok(())
        }
        .await;
        let _ = std::fs::remove_file(&patch);
        result
    }

    /// Task worktrees (`hivecode/task-*`) git knows about. A cancelled or failed task leaves its
    /// worktree behind on purpose, so the work can be inspected; this is how they are found again.
    pub async fn list_task_worktrees(
        &self,
        project: &Path,
        include_swarm: bool,
    ) -> Vec<TaskWorktree> {
        let Ok(listed) = git(project, &["worktree", "list", "--porcelain"]).await else {
            return vec![];
        };
        if !listed.ok {
            return vec![];
        }
        let mut found = vec![];
        for block in listed.text().split("\n\n") {
            let path = block.lines().find_map(|l| l.strip_prefix("worktree "));
            let branch = block
                .lines()
                .find_map(|l| l.strip_prefix("branch refs/heads/"))
                .filter(|b| b.starts_with("hivecode/task-") || b.starts_with("hivecode/swarm-"));
            let (Some(path), Some(branch)) = (path, branch) else {
                continue;
            };
            if branch.starts_with("hivecode/swarm-") && !include_swarm {
                continue;
            }
            let task_slug = branch
                .trim_start_matches("hivecode/")
                .trim_start_matches("task-")
                .to_owned();
            let mut a = self.assignment(&task_slug, project, true);
            a.worktree = path.into();
            // Unreadable: keep it rather than delete it.
            let has_changes = self
                .diff(&a)
                .await
                .map(|d| !d.trim().is_empty())
                .unwrap_or(true);
            found.push(TaskWorktree {
                path: path.into(),
                branch: branch.into(),
                task_slug,
                has_changes,
            });
        }
        found
    }

    pub async fn cleanup(&self, a: &Assignment) -> Result<()> {
        if !a.isolated {
            return Ok(());
        }
        let worktree = a.worktree.to_string_lossy();
        git_ok(
            &a.project,
            &["worktree", "remove", "--force", &worktree],
            "Failed to remove worktree",
        )
        .await?;
        if let Some(baseline) = &a.baseline_ref {
            git(&a.project, &["update-ref", "-d", baseline]).await?;
        }
        git(&a.project, &["branch", "-D", &a.branch]).await?;
        Ok(())
    }

    async fn seed_baseline(&self, a: &Assignment, base_ref: &str) -> Result<()> {
        let base = git_ok(
            &a.project,
            &["diff", "--binary", base_ref, "--"],
            "Failed to inspect base workspace",
        )
        .await?;
        let base_diff = base.text();
        if !base_diff.trim().is_empty() {
            let patch = patch_path("hivecode-base", &a.task_id);
            std::fs::write(&patch, &base_diff)?;
            let applied = git(
                &a.worktree,
                &["apply", "--whitespace=nowarn", &patch.to_string_lossy()],
            )
            .await;
            let _ = std::fs::remove_file(&patch);
            let applied = applied?;
            if !applied.ok {
                return Err(format!("Failed to seed base changes: {}", applied.message()).into());
            }
        }
        let untracked = git_ok(
            &a.project,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            "Failed to inspect untracked files",
        )
        .await?;
        for file in untracked.text().split('\0').filter(|f| !f.is_empty()) {
            let (source, target) = (a.project.join(file), a.worktree.join(file));
            // The file may have disappeared between ls-files and the copy; ignore it.
            if !source.is_file() {
                continue;
            }
            if let Some(dir) = target.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::copy(&source, &target);
        }
        git_ok(&a.worktree, &["add", "-A"], "Failed to stage baseline").await?;
        let tree = git_ok(
            &a.worktree,
            &["write-tree"],
            "Failed to write baseline tree",
        )
        .await?
        .text();
        let head = git_ok(
            &a.worktree,
            &["rev-parse", "HEAD"],
            "Failed to resolve baseline parent",
        )
        .await?
        .text();
        let message = format!("hivecode baseline for {}", a.task_id);
        let commit = git_ok(
            &a.worktree,
            &[
                "-c",
                "user.name=HiveCode",
                "-c",
                "user.email=hivecode@local",
                "commit-tree",
                tree.trim(),
                "-p",
                head.trim(),
                "-m",
                &message,
            ],
            "Failed to create baseline commit",
        )
        .await?
        .text();
        let commit = commit.trim();
        if let Some(baseline) = &a.baseline_ref {
            git_ok(
                &a.worktree,
                &["update-ref", baseline, commit],
                "Failed to record baseline ref",
            )
            .await?;
        }
        git_ok(
            &a.worktree,
            &["reset", "--hard", commit],
            "Failed to reset worktree to baseline",
        )
        .await?;
        Ok(())
    }
}
