/**
 * Regression tests for the harness recovery plumbing (Fase 2).
 *
 * The systemic bug these pin: the Scribe persisted recovery state to HiveDB but
 * every read served from an in-memory cache that started empty in each process,
 * so crash recovery never actually recovered anything. These tests exercise the
 * cross-process path — write with one Scribe instance, flush, then read with a
 * FRESH instance that only sees the data if it hydrates from HiveDB.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { Scribe } from "@johpaz/hivecode-code/narrative/scribe"

const previousHiveDbPath = process.env.HIVE_DB_PATH

beforeEach(() => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-recovery-")), "hivedb")
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

describe("Scribe cross-process recovery", () => {
  test("a fresh Scribe hydrates recovery points written by a prior instance", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    const taskId = writer.createTask(sessionId, "build the auth module", "auto")
    writer.saveRecoveryPoint(taskId, null, [0, 1], [2, 3], 2)
    await writer.flush()

    // A brand-new instance (simulating a restarted process) sees nothing until it hydrates.
    const restarted = new Scribe()
    expect(restarted.getLatestRecoveryPoint(taskId)).toBeNull()

    await restarted.hydrate()
    const recovery = restarted.getLatestRecoveryPoint(taskId)
    expect(recovery).not.toBeNull()
    expect(recovery!.level).toBe(2) // exposed for resumeTask's startLevel
    expect(recovery!.completedPhases).toEqual([0, 1])
  })

  test("hydrate surfaces interrupted (non-terminal) tasks for reconciliation", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    const running = writer.createTask(sessionId, "running task", "auto")
    const done = writer.createTask(sessionId, "done task", "auto")
    writer.updateTaskStatus(done, "completed")
    await writer.flush()

    const restarted = new Scribe()
    await restarted.hydrate()
    const interrupted = restarted.findInterruptedTasks().map((task) => task.id)
    expect(interrupted).toContain(running)
    expect(interrupted).not.toContain(done)
  })

  test("savePlan/getPlan round-trips the plan needed to resume a task", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    const taskId = writer.createTask(sessionId, "add rate limiting", "auto")
    const phases = [
      { name: "api", coordinator: "backend", description: "endpoints", dependsOn: [] },
      { name: "review", coordinator: "reviewer", description: "gate", dependsOn: ["backend"] },
    ]
    writer.savePlan(taskId, {
      phases,
      description: "add rate limiting",
      provider: "anthropic",
      model: "claude-sonnet-5",
      archNarrative: "use a token bucket",
      interfaces: null,
      mode: "auto",
    })
    await writer.flush()

    const restarted = new Scribe()
    const plan = await restarted.getPlan(taskId)
    expect(plan).not.toBeNull()
    expect(plan!.provider).toBe("anthropic")
    expect(JSON.parse(plan!.phases_json)).toHaveLength(2)
  })
})
