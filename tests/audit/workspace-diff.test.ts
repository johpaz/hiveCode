import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../../packages/code/src/workspace/manager";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

test("integrating a task leaves out the agent's .hive-bak backups", async () => {
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

    const result = await manager.integrate(assignment);

    expect(result.status).toBe("integrated");
    expect(git(repo, "status", "--short").toString()).toContain("b.ts");
    expect(git(repo, "status", "--short").toString()).not.toContain("hive-bak");
  } finally {
    await manager.cleanup(assignment);
  }
});
