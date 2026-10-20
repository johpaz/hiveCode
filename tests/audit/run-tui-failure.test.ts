import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { getHiveDir } from "../../packages/core/src/config/loader";
import { run } from "../../packages/cli/src/commands-code/run";

test("a failed task run from the TUI is rethrown instead of retrying and exiting the process", async () => {
  mkdirSync(getHiveDir(), { recursive: true })
  const exit = process.exit
  let exited = false
  process.exit = ((): never => { exited = true; throw new Error("process.exit called") }) as typeof process.exit
  const manager = {
    runTask: async () => { throw new Error("Session and workspace do not match") },
    getActiveTaskId: () => "task-x",
    getSessionId: () => "session-x",
    stopAll: async () => {},
  }
  try {
    await expect(
      run("Crea una CLI de notas con tests", ["--approval"], { manager: manager as any, quiet: true, exitOnError: false }),
    ).rejects.toThrow("Session and workspace do not match")
    expect(exited).toBe(false)
  } finally {
    process.exit = exit
  }
});
