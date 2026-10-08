import { test, expect } from "bun:test";
import { runWithTaskSignal, spawnTaskProcess } from "../../packages/core/src/runtime/task-execution";
import { inspectProcess } from "../../packages/core/src/runtime/process-identity";

test("abort stops owned subprocess and blocks subsequent tools", async () => {
 const controller = new AbortController();
 let pid = 0;
 const running = runWithTaskSignal(controller.signal, async () => {
  const child = spawnTaskProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  pid = child.pid;
  await child.exited;
 });
 controller.abort(); await running;
 if (process.platform === "linux") expect(inspectProcess(pid, process.cwd())).toBeNull();
 let invoked = false;
 await expect(runWithTaskSignal(controller.signal, async () => { invoked = true; })).rejects.toThrow();
 expect(invoked).toBe(false);
});
