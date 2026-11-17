//! Real `git` against temporary repositories; no network, no model.
use hivecode_workspace::{Integration, Workspaces, is_noise, slug};
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
    std::fs::write(dir.path().join("a.txt"), "uno\ndos\ntres\n").unwrap();
    std::fs::write(dir.path().join("b.txt"), "b\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-q", "-m", "init"]);
    dir
}

#[test]
fn slugs_and_noise() {
    assert_eq!(
        slug("Tarea #1: Árbol/De Archivos"),
        "tarea-1-rbol-de-archivos"
    );
    assert_eq!(slug("!!!"), "task");
    assert_eq!(slug(&"x".repeat(200)).len(), 80);
    for noise in [
        "a.txt.hive-bak.1700",
        "web/node_modules/x/y.js",
        ".qg/out",
        "src/.cache/z",
        ".verify-1",
        "run.log",
    ] {
        assert!(is_noise(noise), "{noise}");
    }
    for real in ["src/main.rs", "notes.txt", "a.hive-bak.x", "logs/readme.md"] {
        assert!(!is_noise(real), "{real}");
    }
}

#[tokio::test]
async fn a_task_works_in_its_own_copy_and_integrates_only_its_own_changes() {
    let project = repo();
    // The project already has uncommitted work and an untracked file; the task must start from them.
    std::fs::write(project.path().join("b.txt"), "b editado por la persona\n").unwrap();
    std::fs::write(project.path().join("nuevo.txt"), "sin seguimiento\n").unwrap();
    let root = tempfile::tempdir().unwrap();
    let ws = Workspaces::new(root.path());
    let a = ws.assignment("T001 construir", project.path(), true);
    ws.prepare(&a, "HEAD").await.unwrap();

    assert_eq!(
        std::fs::read_to_string(a.worktree.join("b.txt")).unwrap(),
        "b editado por la persona\n"
    );
    assert!(
        a.worktree.join("nuevo.txt").exists(),
        "untracked files are seeded"
    );
    assert_eq!(
        ws.integrate(&a).await,
        Integration::Noop,
        "nothing done yet, so nothing to integrate"
    );

    std::fs::write(a.worktree.join("a.txt"), "uno\nDOS\ntres\n").unwrap();
    std::fs::write(a.worktree.join("creado.rs"), "fn main() {}\n").unwrap();
    std::fs::create_dir_all(a.worktree.join("node_modules/dep")).unwrap();
    std::fs::write(a.worktree.join("node_modules/dep/i.js"), "x").unwrap();
    std::fs::write(a.worktree.join("debug.log"), "x").unwrap();

    let Integration::Integrated { diff } = ws.integrate(&a).await else {
        panic!("expected integration")
    };
    assert!(diff.contains("+DOS") && diff.contains("creado.rs"));
    assert!(
        !diff.contains("node_modules") && !diff.contains("debug.log"),
        "noise stays out"
    );
    assert!(
        !diff.contains("editado por la persona"),
        "the person's own edits are not the task's"
    );
    assert_eq!(
        std::fs::read_to_string(project.path().join("a.txt")).unwrap(),
        "uno\nDOS\ntres\n"
    );
    assert!(project.path().join("creado.rs").exists());
    assert_eq!(
        std::fs::read_to_string(project.path().join("b.txt")).unwrap(),
        "b editado por la persona\n",
        "the person's edit survives"
    );
    assert!(!project.path().join("debug.log").exists());

    ws.cleanup(&a).await.unwrap();
    assert!(!a.worktree.exists());
    assert!(
        git(project.path(), &["branch", "--list", "hivecode/*"])
            .trim()
            .is_empty()
    );
    assert!(
        git(project.path(), &["for-each-ref", "refs/hivecode"])
            .trim()
            .is_empty()
    );
}

#[tokio::test]
async fn a_change_that_clashes_with_the_project_is_reported_as_a_conflict_and_nothing_is_applied() {
    let project = repo();
    let root = tempfile::tempdir().unwrap();
    let ws = Workspaces::new(root.path());
    let a = ws.assignment("clash", project.path(), true);
    ws.prepare(&a, "HEAD").await.unwrap();
    std::fs::write(a.worktree.join("a.txt"), "uno\nDESDE-LA-TAREA\ntres\n").unwrap();
    // Meanwhile the project changes the same line.
    std::fs::write(
        project.path().join("a.txt"),
        "uno\nDESDE-EL-PROYECTO\ntres\n",
    )
    .unwrap();

    match ws.integrate(&a).await {
        Integration::Conflict { .. } | Integration::Failed { .. } => {}
        other => panic!("expected a conflict, got {other:?}"),
    }
    let content = std::fs::read_to_string(project.path().join("a.txt")).unwrap();
    assert!(
        !content.contains("DESDE-LA-TAREA"),
        "a failed integration must not leave the task's line behind: {content}"
    );
}

#[tokio::test]
async fn leftover_worktrees_are_listed_with_whether_they_hold_unintegrated_work() {
    let project = repo();
    let root = tempfile::tempdir().unwrap();
    let ws = Workspaces::new(root.path());
    let clean = ws.assignment("limpia", project.path(), true);
    let dirty = ws.assignment("sucia", project.path(), true);
    ws.prepare(&clean, "HEAD").await.unwrap();
    ws.prepare(&dirty, "HEAD").await.unwrap();
    std::fs::write(dirty.worktree.join("trabajo.txt"), "pendiente\n").unwrap();

    let mut listed = ws.list_task_worktrees(project.path(), false).await;
    listed.sort_by(|x, y| x.task_slug.cmp(&y.task_slug));
    assert_eq!(listed.len(), 2);
    assert_eq!(
        (listed[0].task_slug.as_str(), listed[0].has_changes),
        ("limpia", false)
    );
    assert_eq!(
        (listed[1].task_slug.as_str(), listed[1].has_changes),
        ("sucia", true)
    );

    // A read-only task gets no worktree at all.
    let reader = ws.assignment("lee", project.path(), false);
    assert!(!reader.isolated);
    assert_eq!(reader.worktree, project.path());
    ws.prepare(&reader, "HEAD").await.unwrap();
    assert_eq!(ws.integrate(&reader).await, Integration::Noop);
}

#[tokio::test]
async fn an_integrated_patch_can_be_reverted_and_a_changed_project_is_refused_untouched() {
    let project = repo();
    let root = tempfile::tempdir().unwrap();
    let ws = Workspaces::new(root.path());
    let a = ws.assignment("deshacer", project.path(), true);
    ws.prepare(&a, "HEAD").await.unwrap();
    std::fs::write(a.worktree.join("a.txt"), "uno\nDOS\ntres\n").unwrap();
    std::fs::write(a.worktree.join("nuevo.rs"), "fn main() {}\n").unwrap();
    let Integration::Integrated { diff } = ws.integrate(&a).await else {
        panic!("expected integration")
    };
    ws.cleanup(&a).await.unwrap();

    ws.revert(project.path(), &diff).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(project.path().join("a.txt")).unwrap(),
        "uno\ndos\ntres\n"
    );
    assert!(
        !project.path().join("nuevo.rs").exists(),
        "a created file is removed"
    );

    // Applied again, then the person edits the same line: reverting would clobber their work.
    let a2 = ws.assignment("deshacer-2", project.path(), true);
    ws.prepare(&a2, "HEAD").await.unwrap();
    std::fs::write(a2.worktree.join("a.txt"), "uno\nDOS\ntres\n").unwrap();
    let Integration::Integrated { diff } = ws.integrate(&a2).await else {
        panic!("expected integration")
    };
    ws.cleanup(&a2).await.unwrap();
    std::fs::write(
        project.path().join("a.txt"),
        "uno\nEDITADO-POR-LA-PERSONA\ntres\n",
    )
    .unwrap();
    let error = ws
        .revert(project.path(), &diff)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("changed since this run"), "{error}");
    assert_eq!(
        std::fs::read_to_string(project.path().join("a.txt")).unwrap(),
        "uno\nEDITADO-POR-LA-PERSONA\ntres\n",
        "nothing was touched"
    );
}
