/**
 * The session-switch journey, end to end minus the terminal.
 *
 * `/session resume` used to be a dead end: the parser flipped a row in the
 * database while the runtime kept writing to the original session, so the picker
 * and the runtime disagreed about which conversation was live. These tests walk
 * the whole path — the real parser, the real CoordinatorManager, the real
 * Scribe — and assert on what the TUI would be told, because that refilling the
 * TUI is half the contract: `switchSession` clears its panels, so skipping the
 * snapshot would leave an empty screen.
 *
 * What this does NOT cover is the keystroke and the socket: the real binary and
 * `launchTui` are exercised separately in tests/e2e.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeSessionDoc } from "@johpaz/hivecode-core/storage/collections"
import { Scribe } from "@johpaz/hivecode-code/narrative/scribe"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { parseInternalCommand, type ContextState } from "@johpaz/hivecode-code/coordinator/command-parser"
import { applySessionSwitch } from "../../packages/cli/src/commands-code/session-commands"

const PROJECT = "/tmp/mi-proyecto"
const previousHiveDbPath = process.env.HIVE_DB_PATH

let refreshed: string[] = []

beforeEach(() => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-switch-e2e-")), "hivedb")
  refreshed = []
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

/** What the TUI is handed, standing in for launchTui's snapshot machinery. */
const refreshSession = async (sessionId: string) => { refreshed.push(sessionId) }

function ctxFor(sessionId: string): ContextState {
  return {
    sessionId,
    activeProvider: "",
    activeModel: "",
    activeMode: "approval",
    activeMcp: [],
    activeSkills: [],
    projectPath: PROJECT,
  }
}

async function seedSession(message: string, title?: string): Promise<string> {
  const scribe = new Scribe()
  const sessionId = scribe.createSession(PROJECT)
  const turnId = scribe.createTurn(sessionId, message)
  scribe.completeTurn(turnId, "respuesta del agente")
  await scribe.flush()
  if (title) {
    const sessions = await col<CodeSessionDoc>("codeSessions")
    const row = await sessions.get(sessionId)
    await sessions.put(sessionId, { ...row!.doc, title }, { expectedVersion: row!.version })
  }
  return sessionId
}

/** Type a slash command and do exactly what the REPL does with the answer. */
async function runCommand(manager: CoordinatorManager, input: string) {
  const result = await parseInternalCommand(input, undefined, ctxFor(manager.getSessionId() ?? "none"))
  if (result.switchSession) {
    await applySessionSwitch(result.switchSession, {
      manager,
      refreshSession,
      defaultProjectPath: PROJECT,
    })
  }
  return result
}

describe("switching sessions from a slash command", () => {
  test("/session resume moves the runtime and refills the TUI", async () => {
    const previous = await seedSession("arregla el login", "arregla el login OAuth")
    const target = await seedSession("migra el esquema", "migrar a Postgres")

    const manager = new CoordinatorManager()
    manager.switchSession(previous, PROJECT)
    refreshed = []

    const result = await runCommand(manager, `/session resume ${target.slice(-8)}`)

    expect(result.switchSession).toEqual({ sessionId: target, projectPath: PROJECT })
    // The runtime followed — this is the assertion the old code failed.
    expect(manager.getSessionId()).toBe(target)
    // And the TUI was refilled, because switchSession cleared it.
    expect(refreshed).toEqual([target])
  })

  test("work after the switch is stored under the resumed session", async () => {
    const previous = await seedSession("arregla el login")
    const target = await seedSession("migra el esquema")

    const manager = new CoordinatorManager()
    manager.switchSession(previous, PROJECT)
    await runCommand(manager, `/session resume ${target.slice(-8)}`)

    const scribe = new Scribe()
    const turnId = scribe.createTurn(manager.getSessionId()!, "trabajo tras reanudar")
    scribe.completeTurn(turnId, "hecho")
    await scribe.flush()

    const turns = await col<any>("codeTurns")
    await turns.createIndex("session_id")
    const inTarget = (await turns.findBy("session_id", target)).map((e) => e.doc.user_message)
    const inPrevious = (await turns.findBy("session_id", previous)).map((e) => e.doc.user_message)

    expect(inTarget).toContain("trabajo tras reanudar")
    expect(inPrevious).not.toContain("trabajo tras reanudar")
  })

  test("the picker lists the session we resumed, with its title", async () => {
    const previous = await seedSession("arregla el login")
    const target = await seedSession("migra el esquema", "migrar a Postgres")

    const manager = new CoordinatorManager()
    manager.switchSession(previous, PROJECT)
    const listed = await runCommand(manager, "/session list")

    expect(listed.output).toContain("migrar a Postgres")
    expect(listed.output).toContain(target.slice(-8))
  })

  test("/session new closes the session and needs no snapshot", async () => {
    const only = await seedSession("trabajo en curso")

    const manager = new CoordinatorManager()
    manager.switchSession(only, PROJECT)
    refreshed = []

    await runCommand(manager, "/session new")

    expect(manager.getSessionId()).toBeNull()
    // Nothing to show: an empty snapshot would be noise, and the TUI was already
    // told by `session_changed`.
    expect(refreshed).toEqual([])
  })

  test("resuming the session already open changes nothing", async () => {
    const only = await seedSession("trabajo en curso")

    const manager = new CoordinatorManager()
    manager.switchSession(only, PROJECT)
    refreshed = []

    const result = await runCommand(manager, `/session resume ${only.slice(-8)}`)

    expect(result.switchSession).toBeUndefined()
    expect(manager.getSessionId()).toBe(only)
    expect(refreshed).toEqual([])
  })

  test("the picker only offers this project's sessions", async () => {
    const elsewhere = new Scribe()
    const foreignId = elsewhere.createSession("/tmp/otro-proyecto")
    elsewhere.createTurn(foreignId, "trabajo de otro repo")
    await elsewhere.flush()

    await seedSession("trabajo de este repo")

    const manager = new CoordinatorManager()
    const listed = await runCommand(manager, "/session list")

    expect(listed.output).toContain("trabajo de este repo")
    expect(listed.output).not.toContain("trabajo de otro repo")
  })
})