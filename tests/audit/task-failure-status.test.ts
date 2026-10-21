import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinatorManager } from "../../packages/code/src/workers/coordinator-manager";
import { setExecutionMode } from "../../packages/core/src/agent/execution-mode";
import { bootstrap } from "../../packages/core/src/storage/bootstrapper";
import { col } from "../../packages/core/src/storage/hive";
import type { CodeTaskDoc } from "../../packages/core/src/storage/collections";
import { cleanupApiKey, isolateHiveDb, restoreDbPath, seedApiKey, seedFixture } from "../e2e/helpers";

const previousHome = process.env.HIVE_HOME;
beforeEach(async () => {
  isolateHiveDb();
  await seedApiKey();
  process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hivecode-home-"));
  setExecutionMode("auto");
});
afterAll(async () => {
  await cleanupApiKey();
  restoreDbPath();
  if (previousHome === undefined) delete process.env.HIVE_HOME; else process.env.HIVE_HOME = previousHome;
});

test("a task whose model cannot be reached ends as failed, not left pending", async () => {
  await bootstrap({ force: true }); // indexes the harness queries rely on
  await seedFixture({ baseUrl: "http://127.0.0.1:9/v1" }); // nothing listens there
  const manager = new CoordinatorManager();
  const events: string[] = [];
  manager.setIpcCallback((event, payload: any) => { if (event === "task_update") events.push(String(payload?.status)); });
  let taskId: string | null = null;
  await expect(manager.runTask("hola", "auto").catch(err => { taskId = manager.getActiveTaskId(); throw err; })).rejects.toThrow();
  taskId = taskId ?? manager.getActiveTaskId();
  expect(taskId).toBeTruthy();
  // The scribe writes without awaiting; give the write a moment to land.
  let status: string | undefined;
  for (let i = 0; i < 40 && status !== "failed"; i++) {
    status = (await (await col<CodeTaskDoc>("codeTasks")).get(taskId!))?.doc.status;
    if (status !== "failed") await Bun.sleep(50);
  }
  expect(status).toBe("failed");
  expect(events).toContain("failed");
}, 60_000);
