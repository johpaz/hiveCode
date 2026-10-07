/**
 * Session lifecycle (Fase 3) — a session is created on the user's first message.
 *
 * The behaviour this pins: constructing the runtime must not write a session.
 * Opening the TUI and closing it without typing used to leave a nameless row in
 * the picker, one per launch, forever. The session now appears only when the
 * user says something, so a fresh manager has no id and no stored doc.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeSessionDoc } from "@johpaz/hivecode-core/storage/collections"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"

const previousHiveDbPath = process.env.HIVE_DB_PATH

beforeEach(() => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-lifecycle-")), "hivedb")
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

async function countSessions(): Promise<number> {
  return (await (await col<CodeSessionDoc>("codeSessions")).scan()).length
}

describe("session lifecycle", () => {
  test("a fresh runtime has no session and writes no session doc", async () => {
    const manager = new CoordinatorManager()

    // The TUI boots with this, and sends an empty session_id in `init`.
    expect(manager.getSessionId()).toBeNull()
    // The real point: nothing was persisted, so no nameless picker rows.
    expect(await countSessions()).toBe(0)
  })

  test("closing a runtime that never opened a session is a no-op", () => {
    const manager = new CoordinatorManager()

    // exit path — must not throw on the missing session
    expect(() => manager.closeSession()).not.toThrow()
    expect(manager.getSessionId()).toBeNull()
  })
})