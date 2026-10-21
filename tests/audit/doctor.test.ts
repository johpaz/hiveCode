import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderRuntimeDiagnostics, runtimeDiagnostics, summarizeDiagnostics } from "../../packages/core/src/services/diagnostics";
import { bootstrap } from "../../packages/core/src/storage/bootstrapper";
import { col } from "../../packages/core/src/storage/hive";
import { cleanupApiKey, isolateHiveDb, restoreDbPath, seedApiKey, seedFixture } from "../e2e/helpers";

beforeEach(async () => { isolateHiveDb(); await bootstrap({ force: true }); });
afterAll(async () => { await cleanupApiKey(); restoreDbPath(); });

const find = (checks: Awaited<ReturnType<typeof runtimeDiagnostics>>, name: string) => checks.find(c => c.name === name);

test("without a provider (first run) the doctor warns and says how to fix it", async () => {
  const checks = await runtimeDiagnostics({ quick: true });
  const provider = find(checks, "Provider");
  expect(provider?.status).toBe("warn");
  expect(provider?.fix).toContain("Providers");
});

test("a configured provider with its key and model passes, and BEE inherits it", async () => {
  await seedApiKey();
  await seedFixture({ baseUrl: "http://127.0.0.1:9/v1" });
  const checks = await runtimeDiagnostics({ quick: true });
  expect(find(checks, "Provider")?.status).not.toBe("fail");
  expect(find(checks, "API key")?.status).toBe("pass");
  expect(find(checks, "Modelo")?.status).toBe("pass");
  expect(find(checks, "Modelo de BEE")?.message).toContain("heredado");
});

test("a provider without a key is an error that points at the Providers tab", async () => {
  await seedFixture({ baseUrl: "http://127.0.0.1:9/v1" });
  await cleanupApiKey();
  const key = find(await runtimeDiagnostics({ quick: true }), "API key");
  expect(key?.status).toBe("fail");
  expect(key?.fix).toContain("F2");
});

test("every core profile is checked, not a stale count of coordinators", async () => {
  const profiles = find(await runtimeDiagnostics({ quick: true }), "Perfiles");
  expect(["pass", "fail"]).toContain(profiles?.status);
  if (profiles?.status === "fail") expect(profiles.message).toMatch(/Faltan perfiles/);
});

test("a project that is not a git repository is flagged; a repository with a leftover task worktree is too", async () => {
  const plain = mkdtempSync(join(tmpdir(), "hive-doctor-plain-"));
  const noGit = find(await runtimeDiagnostics({ cwd: plain }), "Repositorio");
  expect(noGit?.status).toBe("warn");

  const repo = mkdtempSync(join(tmpdir(), "hive-doctor-repo-"));
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" });
  run("init", "-q", "-b", "main"); run("commit", "-q", "--allow-empty", "-m", "init");
  run("worktree", "add", "-q", "-b", "hivecode/task-demo", join(mkdtempSync(join(tmpdir(), "hive-doctor-wt-")), "wt"));
  const checks = await runtimeDiagnostics({ cwd: repo });
  expect(find(checks, "Repositorio")?.status).toBe("pass");
  const stale = find(checks, "Worktrees de tareas");
  expect(stale?.status).toBe("warn");
  expect(stale?.fix).toContain("/task cleanup");
});

test("the untouched Telegram row that ships with the database is not an error", async () => {
  const telegram = find(await runtimeDiagnostics({ quick: true }), "Telegram");
  expect(telegram?.status).toBe("pass");
});

test("Telegram configured without a token is an error", async () => {
  const channels = await col<any>("channels");
  await channels.put("telegram", { id: "telegram", type: "telegram", enabled: true, active: true, status: "configured" });
  const prior = await Bun.secrets.get({ service: "hive-code", name: "telegram.bot_token" }).catch(() => null);
  if (prior) return; // never touch a real token: the check is covered where there is none
  const telegram = find(await runtimeDiagnostics({ quick: true }), "Telegram");
  expect(telegram?.status).toBe("fail");
});

test("the report is grouped by section, shows the fix under each problem and ends with a verdict", async () => {
  const text = await renderRuntimeDiagnostics({ quick: true });
  expect(text).toContain("── Sistema ──");
  expect(text).toContain("── Modelo ──");
  expect(text).toMatch(/→ /);
  expect(text.split("\n").at(-1)).toMatch(/error|aviso|Todo en orden/);
  const { pass, warn, fail } = summarizeDiagnostics(await runtimeDiagnostics({ quick: true }));
  expect(pass + warn + fail).toBeGreaterThan(5);
});
