import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHiveDb } from "../../packages/core/src/storage/hivedb";

import { CoordinatorManager } from "../../packages/code/src/workers/coordinator-manager";
import { ProfileHarness } from "../../packages/core/src/harness/profile-harness";

// El ProfileHarness real llama al LLM: aquí sólo importa lo que el coordinador
// hace con su resultado en modo plan. Se parchea el prototipo (y se restaura)
// en vez de `mock.module`, que en Bun se filtra a los demás archivos de test.
const realRun = ProfileHarness.prototype.run

test("plan mode emits plan_update, needs no git worktree and leaves the cwd untouched", async () => {
  const previousDb = process.env.HIVE_DB_PATH
  const previousCwd = process.cwd()
  closeHiveDb()
  process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-plan-"))
  // Carpeta vacía y sin repo git, como `Bee`: un worktree aquí fallaría.
  process.chdir(mkdtempSync(join(tmpdir(), "hive-plan-cwd-")))
  ProfileHarness.prototype.run = (async () => (
    { taskId: "t", complexity: "feature", status: "ready", response: "PLAN: bee-notes", repairCycles: 0 }
  )) as unknown as typeof realRun
  try {
    const manager = new CoordinatorManager()
    const events: Array<{ event: string; payload: any }> = []
    manager.setIpcCallback((event, payload) => events.push({ event, payload }))

    await manager.runTask("Diseña un arnés para una CLI llamada bee-notes con tests", "plan")

    const update = events.find(e => e.event === "plan_update")
    expect(update?.payload.adr_content).toBe("PLAN: bee-notes")
    expect(update?.payload.status).toBe("pending")
    // La TUI rechaza un plan sin ADR o sin fases ("plan incompleto").
    expect(update?.payload.adr_title).not.toBe("")
    expect(update?.payload.phases.length).toBeGreaterThan(0)
    const runtime = manager as any
    expect([...runtime.taskWorkspaces.values()].every((w: any) => !w.isolated)).toBe(true)
  } finally {
    ProfileHarness.prototype.run = realRun
    process.chdir(previousCwd)
    closeHiveDb()
    if (previousDb === undefined) delete process.env.HIVE_DB_PATH
    else process.env.HIVE_DB_PATH = previousDb
  }
})
