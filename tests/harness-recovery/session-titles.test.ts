/**
 * Session naming (Fase 2) — a session's display name is its user's request.
 *
 * Two writers, one field: `Scribe.createTurn` stamps a provisional title (the
 * first user message, truncated) so a session is never nameless, and the
 * background namer refines it with one LLM call. The contract that matters:
 * the namer may only overwrite the provisional — once a real title lands, no
 * later task renames the session, and an LLM failure leaves the provisional
 * standing rather than an error string.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeSessionDoc } from "@johpaz/hivecode-core/storage/collections"
import { Scribe, PROVISIONAL_TITLE_LIMIT } from "@johpaz/hivecode-code/narrative/scribe"
import {
  nameSessionFromFirstMessage,
  type TitleLLM,
} from "@johpaz/hivecode-code/narrative/session-titles"

// ── LLM stub ────────────────────────────────────────────────────────────────
// Injected per call — NOT `mock.module`, which is process-global in Bun and
// would replace every later test file's real LLM calls with this stub.
// Records what the namer asked for and replays a scripted response, so
// assertions are about actual calls, not inference.
let llmCalls = 0
let seenMessage = ""
let scriptedResponse = "arregla el login OAuth"
let scriptStopReason = "stop" as "stop" | "error"

const stubTitleLLM: TitleLLM = async (userMessage) => {
  llmCalls++
  seenMessage = userMessage
  return { content: scriptedResponse, stop_reason: scriptStopReason }
}

const previousHiveDbPath = process.env.HIVE_DB_PATH

beforeEach(() => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-titles-")), "hivedb")
  llmCalls = 0
  seenMessage = ""
  scriptedResponse = "arregla el login OAuth"
  scriptStopReason = "stop"
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

async function readSession(sessionId: string): Promise<CodeSessionDoc | null> {
  return (await (await col<CodeSessionDoc>("codeSessions")).get(sessionId))?.doc ?? null
}

describe("session naming", () => {
  test("the first turn stamps a provisional title from the user's request", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    writer.createTurn(sessionId, "Arregla el login con OAuth porque falla en Safari")
    await writer.flush()

    // A fresh instance sees it — the stamp is durable, not in-memory.
    const session = await readSession(sessionId)
    expect(session?.title).toBe("Arregla el login con OAuth porque falla en Safari")

    // A second turn never restamps: the session keeps its first request as name.
    writer.createTurn(sessionId, "otra cosa totalmente distinta")
    await writer.flush()
    expect((await readSession(sessionId))?.title).toBe("Arregla el login con OAuth porque falla en Safari")
  })

  test("the provisional is capped at 120 characters", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    const long = "x".repeat(300)
    writer.createTurn(sessionId, long)
    await writer.flush()

    expect((await readSession(sessionId))?.title).toBe("x".repeat(PROVISIONAL_TITLE_LIMIT))
  })

  test("the namer refines the provisional with one LLM call", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    writer.createTurn(sessionId, "Arregla el login con OAuth porque falla en Safari")
    await writer.flush()

    await nameSessionFromFirstMessage(sessionId, stubTitleLLM)

    expect(llmCalls).toBe(1)
    expect((await readSession(sessionId))?.title).toBe("arregla el login OAuth")
  })

  test("a named session is never renamed by a later task", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    writer.createTurn(sessionId, "Arregla el login con OAuth porque falla en Safari")
    await writer.flush()

    await nameSessionFromFirstMessage(sessionId, stubTitleLLM)
    // The session now has an LLM title. A later task must not rename it —
    // the session's name is its FIRST request, not its latest.
    writer.createTurn(sessionId, "ahora refactoriza la base de datos")
    await writer.flush()
    await nameSessionFromFirstMessage(sessionId, stubTitleLLM)

    expect(llmCalls).toBe(1)
    expect((await readSession(sessionId))?.title).toBe("arregla el login OAuth")
  })

  test("an LLM failure keeps the provisional, never saves an error string", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    const request = "Arregla el login con OAuth porque falla en Safari"
    writer.createTurn(sessionId, request)
    await writer.flush()

    // llm-client surfaces errors as content with stop_reason "error".
    scriptStopReason = "error"
    scriptedResponse = "[LLM Error] 429 rate limit"
    await nameSessionFromFirstMessage(sessionId, stubTitleLLM)

    expect((await readSession(sessionId))?.title).toBe(request.slice(0, PROVISIONAL_TITLE_LIMIT))
  })

  test("a failed naming retries on the next task", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    writer.createTurn(sessionId, "Arregla el login con OAuth")
    await writer.flush()

    scriptStopReason = "error"
    await nameSessionFromFirstMessage(sessionId, stubTitleLLM)

    // The provisional survived, so the guard still passes and the next task
    // gets another chance — not a permanently untitled session.
    scriptStopReason = "stop"
    await nameSessionFromFirstMessage(sessionId, stubTitleLLM)
    expect(llmCalls).toBe(2)
    expect((await readSession(sessionId))?.title).toBe("arregla el login OAuth")
  })

  test("model decorations are stripped from the title", async () => {
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    writer.createTurn(sessionId, "Arregla el login con OAuth")
    await writer.flush()

    scriptedResponse = "«Título: Arregla el login OAuth.»\nEspero que te sirva."
    await nameSessionFromFirstMessage(sessionId, stubTitleLLM)

    // Quotes, the prefix, the trailing period and the second line are all gone.
    expect((await readSession(sessionId))?.title).toBe("Arregla el login OAuth")
  })

  test("a pre-field session with no title gets named from its first message", async () => {
    // Sessions created before the field existed have turns but no title. The
    // picker falls back to the raw first message; the first post-upgrade task
    // should give them a real title from that same message.
    const writer = new Scribe()
    const sessionId = writer.createSession(process.cwd())
    writer.createTurn(sessionId, "Arregla el login con OAuth")
    await writer.flush()

    // Simulate the pre-field state: drop the title the stamp just wrote.
    const sessions = await col<CodeSessionDoc>("codeSessions")
    const existing = await sessions.get(sessionId)
    const { title: _drop, ...untitled } = existing!.doc
    await sessions.put(sessionId, untitled as CodeSessionDoc, { expectedVersion: existing!.version })
    expect((await readSession(sessionId))?.title).toBeUndefined()

    await nameSessionFromFirstMessage(sessionId, stubTitleLLM)
    expect((await readSession(sessionId))?.title).toBe("arregla el login OAuth")
  })
})
