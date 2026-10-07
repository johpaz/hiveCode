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
import type { CodeSessionDoc, CodeTurnDoc } from "@johpaz/hivecode-core/storage/collections"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { Scribe } from "@johpaz/hivecode-code/narrative/scribe"

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

/**
 * Session writes are queued and serialised by the Scribe, so a status flip is
 * not visible the instant the method returns. Poll until the store agrees.
 */
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition never held")
}

async function sessionStatus(sessionId: string): Promise<string | undefined> {
  const sessions = await col<CodeSessionDoc>("codeSessions")
  await sessions.createIndex("session_id")
  return (await sessions.get(sessionId))?.doc.status
}

async function turnsOf(sessionId: string): Promise<CodeTurnDoc[]> {
  const turns = await col<CodeTurnDoc>("codeTurns")
  await turns.createIndex("session_id")
  return (await turns.findBy("session_id", sessionId)).map((entry) => entry.doc)
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

/**
 * The split-brain this pins: `/session resume` used to flip the DB status of two
 * sessions while the coordinator kept writing turns, tasks and narrative to the
 * ORIGINAL one — so the picker showed the resumed session and the runtime was
 * still in the old one. Switching now moves the runtime with it, which is
 * observable as: after a switch, a new turn is stored under the target session.
 */
describe("switching sessions", () => {
  async function seedSession(projectPath: string): Promise<string> {
    const scribe = new Scribe()
    const id = scribe.createSession(projectPath)
    await scribe.flush()
    return id
  }

  test("turns written after a switch belong to the session we switched to", async () => {
    const manager = new CoordinatorManager()
    const original = await seedSession("/tmp/proyecto-a")
    const target = await seedSession("/tmp/proyecto-b")

    // Open the original session through the public path a task would use.
    manager.switchSession(original, "/tmp/proyecto-a")
    expect(manager.getSessionId()).toBe(original)

    manager.switchSession(target, "/tmp/proyecto-b")
    expect(manager.getSessionId()).toBe(target)

    // A turn created now must land in the resumed session, not the original.
    const scribe = new Scribe()
    const turnId = scribe.createTurn(manager.getSessionId()!, "trabajo reanudado")
    scribe.completeTurn(turnId, "listo")
    await scribe.flush()

    const stored = await turnsOf(target)
    expect(stored.map((turn) => turn.user_message)).toContain("trabajo reanudado")
    expect(await turnsOf(original)).toHaveLength(0)
  })

  test("switching closes the session being left behind", async () => {
    const manager = new CoordinatorManager()
    const original = await seedSession("/tmp/proyecto-a")
    const target = await seedSession("/tmp/proyecto-b")

    manager.switchSession(original, "/tmp/proyecto-a")
    manager.switchSession(target, "/tmp/proyecto-b")

    await eventually(() => sessionStatus(original), (status) => status === "closed")
    expect(await sessionStatus(target)).toBe("active")
  })

  test("switching to the current session is a no-op", async () => {
    const manager = new CoordinatorManager()
    const only = await seedSession("/tmp/proyecto-a")

    manager.switchSession(only, "/tmp/proyecto-a")
    manager.switchSession(only, "/tmp/proyecto-a")

    expect(manager.getSessionId()).toBe(only)
  })

  test("endSession closes the session and returns to the pre-session state", async () => {
    const manager = new CoordinatorManager()
    const only = await seedSession("/tmp/proyecto-a")
    manager.switchSession(only, "/tmp/proyecto-a")

    manager.endSession()

    // Same state a fresh process starts in — the next message opens a new one.
    expect(manager.getSessionId()).toBeNull()
    await eventually(() => sessionStatus(only), (status) => status === "closed")
  })

  test("a resumed session is marked active so readers agree on which is live", async () => {
    const manager = new CoordinatorManager()
    const original = await seedSession("/tmp/proyecto-a")
    const target = await seedSession("/tmp/proyecto-b")

    manager.switchSession(original, "/tmp/proyecto-a")
    manager.switchSession(target, "/tmp/proyecto-b")

    // Closing a session stamps it with the NEWEST last_active, so anything that
    // resolves "the current session" by date alone would pick the one we left.
    // Status is the honest signal. Wait on the queued close, then assert both.
    await eventually(() => sessionStatus(original), (status) => status === "closed")
    expect(await sessionStatus(target)).toBe("active")
  })
})