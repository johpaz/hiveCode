/**
 * The session picker (Fase 6) — one project, named by its request.
 *
 * Two things this pins. Scoping: the picker is "where was I in THIS repo", so
 * sessions from other projects must not appear. Naming: a row shows the
 * session's title — the LLM name when the renamer ran, the first user message
 * when it did not (which is what the title would have said). Old sessions
 * predate the field and must still read as their request, not as a blank.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { col, updateDoc } from "@johpaz/hivecode-core/storage/hive"
import type { CodeSessionDoc } from "@johpaz/hivecode-core/storage/collections"
import { Scribe } from "@johpaz/hivecode-code/narrative/scribe"
import { parseInternalCommand, type ContextState, type UiCallbacks } from "@johpaz/hivecode-code/coordinator/command-parser"

const PROJECT = "/tmp/mi-proyecto"
const OTHER_PROJECT = "/tmp/otro-proyecto"

const previousHiveDbPath = process.env.HIVE_DB_PATH

beforeEach(() => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-picker-")), "hivedb")
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

function ctxFor(projectPath: string, sessionId: string): ContextState {
  return {
    sessionId,
    activeProvider: "",
    activeModel: "",
    activeMode: "approval",
    activeMcp: [],
    activeSkills: [],
    projectPath,
  }
}

/** A session with one turn, as a real conversation leaves behind. */
async function seedSession(
  projectPath: string,
  userMessage: string,
  title?: string,
): Promise<string> {
  const scribe = new Scribe()
  const sessionId = scribe.createSession(projectPath)
  const turnId = scribe.createTurn(sessionId, userMessage)
  scribe.completeTurn(turnId, "ok")
  await scribe.flush()
  if (title !== undefined) {
    await updateDoc<CodeSessionDoc>("codeSessions", sessionId, { title })
  }
  return sessionId
}

describe("session picker", () => {
  test("lists only the current project's sessions", async () => {
    const mine = await seedSession(PROJECT, "arregla el login")
    await seedSession(OTHER_PROJECT, "migrar la base de datos")

    const result = await parseInternalCommand("/session list", undefined, ctxFor(PROJECT, mine))

    expect(result.output).toContain(mine.slice(-8))
    // Another repo's conversation is noise in "where was I in THIS project".
    expect(result.output).not.toContain("migrar la base de datos")
  })

  test("a row shows the title the renamer produced", async () => {
    const sessionId = await seedSession(PROJECT, "arregla el login con OAuth porque falla en Safari", "arregla el login OAuth")

    const result = await parseInternalCommand("/session list", undefined, ctxFor(PROJECT, sessionId))

    expect(result.output).toContain("arregla el login OAuth")
    // Not the raw 120-char provisional the user typed.
    expect(result.output).not.toContain("porque falla en Safari")
  })

  test("a session with no title falls back to its first request", async () => {
    const sessionId = await seedSession(PROJECT, "migrar el esquema a Postgres")

    const result = await parseInternalCommand("/session list", undefined, ctxFor(PROJECT, sessionId))

    expect(result.output).toContain("migrar el esquema a Postgres")
  })

  test("a long request is trimmed to one readable row", async () => {
    const long = "Necesito que refactorices todo el pipeline de ingestión porque ahora se rompe cada vez que llegan eventos duplicados del proveedor"
    const sessionId = await seedSession(PROJECT, long)
    // A different session is current, so the row carries no "◀ activa" marker
    // and the assertion below sees exactly the label.
    const current = await seedSession(PROJECT, "otra sesión")

    const result = await parseInternalCommand("/session list", undefined, ctxFor(PROJECT, current))

    const row = result.output!.split("\n").find((line) => line.includes(sessionId.slice(-8)))!
    // One line, and it does not spill the whole paragraph.
    expect(row).toContain("Necesito que refactorices")
    expect(row).not.toContain("duplicados del proveedor")
    expect(row.endsWith("…")).toBe(true)
  })

  test("the modal lists titles and still parses back to an id", async () => {
    const target = await seedSession(PROJECT, "arregla el login", "arregla el login OAuth")
    const current = await seedSession(PROJECT, "sesión en curso")
    let capturedOptions: string[] = []
    const ui: UiCallbacks = {
      showConfigModal: async (_cmd, _title, fields) => {
        capturedOptions = fields[0]?.options ?? []
        // The value the TUI returns is the selected row; the command re-reads the
        // id prefix from it, so the id must lead the string.
        return { session: capturedOptions.find((option) => option.startsWith(target.slice(-8)))! }
      },
    }

    const result = await parseInternalCommand("/session resume", undefined, ctxFor(PROJECT, current), ui)

    expect(capturedOptions.find((o) => o.startsWith(target.slice(-8)))!).toContain("arregla el login OAuth")
    expect(result.switchSession).toEqual({ sessionId: target, projectPath: PROJECT })
  })

  test("an empty project reports no sessions instead of listing others", async () => {
    await seedSession(OTHER_PROJECT, "trabajo de otro repo")

    const result = await parseInternalCommand("/session list", undefined, ctxFor(PROJECT, "none"))

    expect(result.output).toContain("No hay sesiones")
    expect(result.output).not.toContain("trabajo de otro repo")
  })

  /**
   * The collision this pins: UUIDv7 leads with a 48-bit millisecond timestamp, so
   * the first 8 hex chars are IDENTICAL for every session started inside the
   * same ~65s window — which is every session you start back to back. Two rows
   * would read the same and `/session resume <chip>` could switch to the wrong
   * conversation. The short id is the random tail.
   */
  test("sessions started moments apart get distinguishable short ids", async () => {
    const first = await seedSession(PROJECT, "primera tarea")
    const second = await seedSession(PROJECT, "segunda tarea")

    // The premise: these really do collide on the leading 8 chars.
    expect(first.slice(0, 8)).toBe(second.slice(0, 8))

    const result = await parseInternalCommand("/session list", undefined, ctxFor(PROJECT, "none"))

    expect(result.output).toContain(first.slice(-8))
    expect(result.output).toContain(second.slice(-8))

    // And the short id selects exactly one session.
    const resumed = await parseInternalCommand(`/session resume ${second.slice(-8)}`, undefined, ctxFor(PROJECT, "none"))
    expect(resumed.switchSession).toEqual({ sessionId: second, projectPath: PROJECT })
  })

  test("the historical leading-prefix form still resolves", async () => {
    const sessionId = await seedSession(PROJECT, "tarea vieja")

    const resumed = await parseInternalCommand(`/session resume ${sessionId.slice(0, 8)}`, undefined, ctxFor(PROJECT, "none"))

    expect(resumed.switchSession).toEqual({ sessionId, projectPath: PROJECT })
  })

  test("an ambiguous fragment is refused with the candidates, not resolved", async () => {
    const first = await seedSession(PROJECT, "primera sesión")
    const second = await seedSession(PROJECT, "segunda sesión")
    const shared = first.slice(0, 8)
    expect(shared).toBe(second.slice(0, 8))

    const result = await parseInternalCommand(`/session resume ${shared}`, undefined, ctxFor(PROJECT, "none"))

    // Refusing is the point: this fragment names two conversations, and the
    // caller behind it re-wires the whole runtime onto the answer.
    expect(result.switchSession).toBeUndefined()
    expect(result.output).toContain("coincide con 2 sesiones")
    expect(result.output).toContain(first.slice(-8))
    expect(result.output).toContain(second.slice(-8))
  })
})

/**
 * The closed-session lie this pins.
 *
 * `getCtx` used to pick the session itself, taking "most recent" whenever
 * nothing was marked active. `/session new` closes the only session and leaves
 * the process with none — so the closed session was still the most recent, and
 * every bare command reported it as live: `/session status` printed
 * "Estado: closed", the picker flagged it "◀ activa", and `/compact` targeted
 * a dead conversation.
 *
 * The parser now takes the session from the process that owns it. `null` means
 * "deliberately none", which is the truth right after `/session new`.
 */
describe("session context after /session new", () => {
  test("a deliberately absent session is reported as absent, not as the closed one", async () => {
    const sessionId = await seedSession(PROJECT, "trabajo terminado", "arregla el login")

    // What the REPL passes once `/session new` has run endSession().
    const result = await parseInternalCommand("/session status", undefined, ctxFor(PROJECT, "none"))

    expect(result.output).toContain("No hay sesión activa")
    expect(result.output).not.toContain(sessionId.slice(-8))
    expect(result.output).not.toContain("closed")
  })

  test("the picker marks no session as active once none is open", async () => {
    await seedSession(PROJECT, "trabajo terminado", "arregla el login")

    const result = await parseInternalCommand("/session list", undefined, ctxFor(PROJECT, "none"))

    // The row is still listed — it is history — but nothing claims to be live.
    expect(result.output).toContain("arregla el login")
    expect(result.output).not.toContain("◀")
  })

  test("an explicit session is still reported", async () => {
    const sessionId = await seedSession(PROJECT, "trabajo en curso", "arregla el login")

    const result = await parseInternalCommand("/session status", undefined, ctxFor(PROJECT, sessionId))

    expect(result.output).toContain(sessionId.slice(-8))
    expect(result.output).toContain("Turnos:")
  })
})

describe("/clear is gone, /session new replaced it", () => {
  test("typing /clear points at the command that replaced it", async () => {
    const result = await parseInternalCommand("/clear", undefined, ctxFor(PROJECT, "none"))

    // It was a real command, so "unknown command" would strand anyone typing it.
    expect(result.output).toContain("/session new")
    expect(result.output).not.toContain("comando desconocido")
  })

  test("/session new asks the runtime to close the session, not to clear the view", async () => {
    const sessionId = await seedSession(PROJECT, "trabajo en curso", "arregla el login")

    const result = await parseInternalCommand("/session new", undefined, ctxFor(PROJECT, sessionId))

    // The old /clear only emptied the transcript and left the session alone.
    // `sessionId: null` is what makes the runtime close it and reopen lazily.
    expect(result.switchSession).toEqual({ sessionId: null })
  })

  test("/session new on a process with no session says so instead of pretending", async () => {
    const result = await parseInternalCommand("/session new", undefined, ctxFor(PROJECT, "none"))

    expect(result.switchSession).toBeUndefined()
    expect(result.output).toContain("No hay sesión activa")
  })
})