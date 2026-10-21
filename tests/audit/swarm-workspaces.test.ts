import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../../packages/code/src/workspace/manager";
import { createSwarmWorkspaceRuntime } from "../../packages/code/src/workspace/swarm-workspaces";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString();

async function taskWorktree() {
  const repo = mkdtempSync(join(tmpdir(), "hive-swarm-repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "shared.ts"), "export const shared = 1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const root = mkdtempSync(join(tmpdir(), "hive-swarm-root-"));
  const manager = new WorkspaceManager({ rootDir: root });
  const task = manager.createAssignment({ taskId: "feat", projectPath: repo, mutating: true });
  await manager.prepare(task);
  const problems: string[] = [];
  const swarm = createSwarmWorkspaceRuntime(manager, m => problems.push(m), root);
  return { repo, task, manager, swarm, problems };
}

test("two instances write in private copies and both merge into the task worktree", async () => {
  const { task, swarm, manager } = await taskWorktree();
  try {
    const a = await swarm.prepare({ taskId: "feat", instanceId: "builder", baseWorkspace: task.worktreePath });
    const b = await swarm.prepare({ taskId: "feat", instanceId: "builder#2", baseWorkspace: task.worktreePath });
    expect(a).not.toBe(b);
    expect(a).not.toBe(task.worktreePath);

    writeFileSync(join(a, "api.ts"), "export const api = 1\n");
    writeFileSync(join(b, "web.ts"), "export const web = 1\n");
    // A private copy: the other instance and the task worktree do not see it yet.
    expect(existsSync(join(b, "api.ts"))).toBe(false);
    expect(existsSync(join(task.worktreePath, "api.ts"))).toBe(false);

    const [ra, rb] = await Promise.all([
      swarm.integrate({ taskId: "feat", instanceId: "builder" }),
      swarm.integrate({ taskId: "feat", instanceId: "builder#2" }),
    ]);
    expect(ra.status).toBe("integrated");
    expect(ra.files).toEqual(["api.ts"]);
    expect(rb.status).toBe("integrated");
    expect(readFileSync(join(task.worktreePath, "api.ts"), "utf-8")).toContain("api");
    expect(readFileSync(join(task.worktreePath, "web.ts"), "utf-8")).toContain("web");
    // Merged copies are removed, with their branches.
    expect(existsSync(a)).toBe(false);
    expect(git(task.worktreePath, "branch", "--list", "hivecode/swarm-*").trim()).toBe("");
  } finally {
    await swarm.cleanup();
    await manager.cleanup(task);
  }
});

test("a new instance starts from what the task already holds, committed or not", async () => {
  const { task, swarm, manager } = await taskWorktree();
  try {
    writeFileSync(join(task.worktreePath, "api.ts"), "export const api = 1\n"); // untracked, from an earlier merge
    writeFileSync(join(task.worktreePath, "shared.ts"), "export const shared = 2\n");
    const b = await swarm.prepare({ taskId: "feat", instanceId: "builder#2", baseWorkspace: task.worktreePath });
    expect(readFileSync(join(b, "api.ts"), "utf-8")).toContain("api");
    expect(readFileSync(join(b, "shared.ts"), "utf-8")).toContain("= 2");
    // Only what the instance itself changed comes back.
    writeFileSync(join(b, "web.ts"), "export const web = 1\n");
    const r = await swarm.integrate({ taskId: "feat", instanceId: "builder#2" });
    expect(r.files).toEqual(["web.ts"]);
  } finally {
    await swarm.cleanup();
    await manager.cleanup(task);
  }
});

test("overlapping edits are reported as a conflict, kept on disk, and warned about", async () => {
  const { task, swarm, manager, problems } = await taskWorktree();
  try {
    const a = await swarm.prepare({ taskId: "feat", instanceId: "builder", baseWorkspace: task.worktreePath });
    const b = await swarm.prepare({ taskId: "feat", instanceId: "builder#2", baseWorkspace: task.worktreePath });
    writeFileSync(join(a, "shared.ts"), "export const shared = 'a'\n");
    writeFileSync(join(b, "shared.ts"), "export const shared = 'b'\n");
    expect((await swarm.integrate({ taskId: "feat", instanceId: "builder" })).status).toBe("integrated");
    const second = await swarm.integrate({ taskId: "feat", instanceId: "builder#2" });
    expect(["conflict", "failed"]).toContain(second.status);
    expect(second.files).toEqual(["shared.ts"]);
    expect(problems.join("\n")).toContain("builder#2");
    expect(existsSync(b)).toBe(true); // kept for the revision
    // The shared tree holds the first instance's version, untouched by the failed merge.
    expect(readFileSync(join(task.worktreePath, "shared.ts"), "utf-8")).toContain("'a'");
    // A revision starts again from the merged state.
    const again = await swarm.prepare({ taskId: "feat", instanceId: "builder#2", baseWorkspace: task.worktreePath });
    expect(readFileSync(join(again, "shared.ts"), "utf-8")).toContain("'a'");
  } finally {
    await swarm.cleanup();
    await manager.cleanup(task);
  }
});
