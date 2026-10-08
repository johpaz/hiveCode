import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinatorManager } from "../../packages/code/src/workers/coordinator-manager";
import { closeHiveDb } from "../../packages/core/src/storage/hivedb";
import { col } from "../../packages/core/src/storage/hive";
import type { CodeTaskDoc } from "../../packages/core/src/storage/collections";

test("coordinator cancels task through the live execution and ignores late messages", async () => {
 const previous = process.env.HIVE_DB_PATH; closeHiveDb(); process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-cancel-"));
 try {
  const tasks = await col<CodeTaskDoc>("codeTasks");
  await tasks.put("cancel-demo", { id:"cancel-demo", status:"running" } as CodeTaskDoc);
  const manager = new CoordinatorManager();
  const runtime = manager as any;
  runtime.activeTaskId = "cancel-demo";
  runtime.taskSupervisor.createTask({ taskId:"cancel-demo", sessionId:"test", title:"demo", stage:"executing", executionPolicy:"auto" });
  const controller = new AbortController(); runtime.taskAborts.set("cancel-demo", controller);
  let ended = false;
  const execution = runtime.trackExecution("cancel-demo", new Promise<void>(resolve => controller.signal.addEventListener("abort", () => { ended = true; resolve(); })));
  const first = manager.cancelTask("cancel-demo"); expect(manager.cancelTask("cancel-demo")).toBe(first);
  await first; await execution;
  expect(ended).toBe(true); expect((await tasks.get("cancel-demo"))?.doc.status).toBe("cancelled");
  runtime.handleWorkerMessage("bee", {type:"THINKING", taskId:"cancel-demo", content:"late"});
  expect((await tasks.get("cancel-demo"))?.doc.status).toBe("cancelled");
 } finally { closeHiveDb(); if(previous===undefined) delete process.env.HIVE_DB_PATH; else process.env.HIVE_DB_PATH=previous; }
});
