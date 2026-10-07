/**
 * Regression test for trace-sharing (Fase 4.5): compileWorkerContext's new
 * "DECISION TRACES" section reads ADRs via Scribe.readDecisions(), which must
 * carry `options`/`context` (what was considered, not just the final `decision`)
 * across a process restart. Reads go straight to HiveDB, so a fresh Scribe
 * instance sees them with no hydration step. This pins that data contract.
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
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-trace-")), "hivedb")
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

describe("decision traces (blackboard trace-sharing)", () => {
  test("a fresh Scribe reads the full trace — options considered, not just the decision", async () => {
    const writer = new Scribe()
    writer.writeDecision({
      id: "adr-1",
      taskId: null,
      title: "Rate limiting strategy",
      context: "Need to prevent API abuse without hurting legitimate bursty clients",
      options: "1) fixed window 2) token bucket 3) sliding log",
      decision: "Token bucket — handles bursts while enforcing a steady long-term rate",
      consequences: "Requires per-client state; use HiveDB working-set with TTL",
      status: "active",
      createdAt: new Date().toISOString(),
    })
    await writer.flush()

    const restarted = new Scribe()
    const [adr] = await restarted.readDecisions("active")

    expect(adr).toBeDefined()
    expect(adr.title).toBe("Rate limiting strategy")
    // The trace — what was considered and why — must survive, not just the outcome.
    expect(adr.options).toContain("token bucket")
    expect(adr.context).toContain("bursty")
  })

  test("superseded/deprecated ADRs are excluded from the active-trace filter", async () => {
    const writer = new Scribe()
    writer.writeDecision({
      id: "adr-old",
      taskId: null,
      title: "old approach",
      context: "c",
      options: "o",
      decision: "d",
      consequences: "x",
      status: "superseded",
      createdAt: new Date().toISOString(),
    })
    await writer.flush()

    const restarted = new Scribe()
    expect(await restarted.readDecisions("active")).toHaveLength(0)
    expect(await restarted.readDecisions("superseded")).toHaveLength(1)
  })
})
