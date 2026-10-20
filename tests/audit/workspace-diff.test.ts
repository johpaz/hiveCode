import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../../packages/code/src/workspace/manager";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

test("integrating a task leaves out .hive-bak backups and node_modules", async () => {
  const repo = mkdtempSync(join(tmpdir(), "hive-ws-repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "export const a = 1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const manager = new WorkspaceManager({ rootDir: mkdtempSync(join(tmpdir(), "hive-ws-root-")) });
  const assignment = manager.createAssignment({ taskId: "bak-demo", projectPath: repo, mutating: true });
  await manager.prepare(assignment);
  try {
    writeFileSync(join(assignment.worktreePath, "b.ts"), "export const b = 2\n");
    writeFileSync(join(assignment.worktreePath, "a.ts.hive-bak.1792500929938"), "export const a = 1\n");

    mkdirSync(join(assignment.worktreePath, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(assignment.worktreePath, "node_modules", "dep", "index.js"), "module.exports = 1\n");

    const result = await manager.integrate(assignment);

    expect(result.status).toBe("integrated");
    expect(git(repo, "status", "--short").toString()).toContain("b.ts");
    expect(git(repo, "status", "--short").toString()).not.toContain("hive-bak");
    expect(git(repo, "status", "--short").toString()).not.toContain("node_modules");
  } finally {
    await manager.cleanup(assignment);
  }
});

test("integrating a task leaves out agent scratch but keeps legitimate dotfiles", async () => {
  const repo = mkdtempSync(join(tmpdir(), "hive-ws-repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "export const a = 1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const manager = new WorkspaceManager({ rootDir: mkdtempSync(join(tmpdir(), "hive-ws-root-")) });
  const assignment = manager.createAssignment({ taskId: "scratch-demo", projectPath: repo, mutating: true });
  await manager.prepare(assignment);
  try {
    const wt = assignment.worktreePath;
    writeFileSync(join(wt, "b.ts"), "export const b = 2\n");
    writeFileSync(join(wt, ".gitignore"), "node_modules\n");
    mkdirSync(join(wt, ".github", "workflows"), { recursive: true });
    writeFileSync(join(wt, ".github", "workflows", "ci.yml"), "name: ci\n");
    // El scratch que dejaron corridas reales del builder.
    mkdirSync(join(wt, ".qg"), { recursive: true });
    writeFileSync(join(wt, ".qg", "registry.txt"), "x\n");
    mkdirSync(join(wt, ".smoke"), { recursive: true });
    writeFileSync(join(wt, ".smoke", "out.txt"), "x\n");
    writeFileSync(join(wt, ".verify-add.log"), "x\n");
    writeFileSync(join(wt, "run.log"), "x\n");

    const result = await manager.integrate(assignment);

    expect(result.status).toBe("integrated");
    const status = git(repo, "status", "--short", "-uall").toString();
    expect(status).toContain("b.ts");
    expect(status).toContain(".gitignore");
    expect(status).toContain(".github/workflows/ci.yml");
    expect(status).not.toContain(".qg");
    expect(status).not.toContain(".smoke");
    expect(status).not.toContain(".verify-");
    expect(status).not.toContain("run.log");
  } finally {
    await manager.cleanup(assignment);
  }
});

test("integrating a task that edits a file the project has but git does not track yet", async () => {
  const repo = mkdtempSync(join(tmpdir(), "hive-ws-repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "export const a = 1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  // Lo que deja la pasada de planificación en el proyecto real: sin versionar.
  mkdirSync(join(repo, "specs", "001-x"), { recursive: true });
  writeFileSync(join(repo, "specs", "001-x", "plan.md"), "# Plan v1\n");

  const manager = new WorkspaceManager({ rootDir: mkdtempSync(join(tmpdir(), "hive-ws-root-")) });
  const assignment = manager.createAssignment({ taskId: "untracked-edit", projectPath: repo, mutating: true });
  await manager.prepare(assignment);
  try {
    // La implementación reescribe el plan y añade código.
    writeFileSync(join(assignment.worktreePath, "specs", "001-x", "plan.md"), "# Plan v2\n");
    writeFileSync(join(assignment.worktreePath, "b.ts"), "export const b = 2\n");

    const result = await manager.integrate(assignment);

    expect(result.status).toBe("integrated");
    expect(readFileSync(join(repo, "specs", "001-x", "plan.md"), "utf-8")).toBe("# Plan v2\n");
    expect(readFileSync(join(repo, "b.ts"), "utf-8")).toBe("export const b = 2\n");
  } finally {
    await manager.cleanup(assignment);
  }
});
