/**
 * Session naming through the real model path.
 *
 * The tests in `session-titles.test.ts` inject a `TitleLLM` stub, which covers
 * the guard and the sanitizer but never touches `resolveNamingProvider`,
 * `resolveProviderConfig` or `callLLM`. This file drives the PRODUCTION
 * `defaultTitleLLM` against a scripted OpenAI-compatible endpoint, so the parts
 * that pick a provider and perform the call are covered too.
 *
 * That combination was verified by hand against a local Ollama (`gemma4:12b`),
 * which is what prompted pinning it: the prompt produced good titles in Spanish
 * and in English, and the only reason it is not a test is that a test must not
 * depend on a model server being up.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { deleteProviderApiKey, storeProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"
import { Scribe } from "@johpaz/hivecode-code/narrative/scribe"
import { nameSessionFromFirstMessage } from "@johpaz/hivecode-code/narrative/session-titles"
import { startFakeModel } from "../e2e/helpers"

const PROVIDER = "title-probe-fake"
const MODEL = "title-probe-model"

const previousHiveDbPath = process.env.HIVE_DB_PATH
let fake: ReturnType<typeof startFakeModel> | null = null

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-title-e2e-")), "hivedb")

  fake = startFakeModel(() => ({ content: "Arreglar login OAuth Safari" }))

  // The OpenAI-compatible provider refuses to call without a key, so a dummy
  // one is stored under a provider id that exists only in this test's database
  // and removed in afterEach.
  await storeProviderApiKey(PROVIDER, "dummy-for-local-fake")

  const now = Date.now()
  await (await col<any>("providers")).put(PROVIDER, {
    id: PROVIDER, user_id: "test", name: "Title Probe Fake",
    enabled: true, active: true, base_url: fake.baseUrl, category: "llm",
    created_at: now, updated_at: now,
  })
  await (await col<any>("models")).put(MODEL, {
    id: MODEL, provider_id: PROVIDER, name: MODEL,
    context_window: 8192, enabled: true, active: true, model_type: "llm",
    created_at: now, updated_at: now,
  })
  // `resolveNamingProvider` falls back to these when no coordinator agent is
  // configured, which is the case on an isolated database.
  await (await col<any>("codeConfig")).put("default_provider", {
    key: "default_provider", value: PROVIDER, updated_at: now,
  })
  await (await col<any>("codeConfig")).put(`provider_model_${PROVIDER}`, {
    key: `provider_model_${PROVIDER}`, value: MODEL, updated_at: now,
  })
})

afterEach(async () => {
  fake?.stop()
  fake = null
  await deleteProviderApiKey(PROVIDER)
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

async function sessionWithFirstMessage(message: string): Promise<string> {
  const scribe = new Scribe()
  const sessionId = scribe.createSession("/tmp/proyecto")
  const turnId = scribe.createTurn(sessionId, message)
  scribe.completeTurn(turnId, "ok")
  await scribe.flush()
  return sessionId
}

async function titleOf(sessionId: string): Promise<string | undefined> {
  return (await (await col<any>("codeSessions")).get(sessionId))?.doc.title
}

describe("session naming through the real model path", () => {
  test("the provider is resolved and the title lands", async () => {
    const sessionId = await sessionWithFirstMessage("arregla el login con OAuth porque falla en Safari")

    await nameSessionFromFirstMessage(sessionId)

    expect(await titleOf(sessionId)).toBe("Arreglar login OAuth Safari")
    expect(fake!.turnCount()).toBe(1)
  })

  test("the model is asked for a bare title, not a conversation", async () => {
    const sessionId = await sessionWithFirstMessage("migra el esquema a Postgres")

    await nameSessionFromFirstMessage(sessionId)

    const sent = fake!.requests[0] as {
      messages: Array<{ role: string; content: string }>
      max_tokens?: number
      chat_template_kwargs?: { enable_thinking?: boolean }
    }
    expect(sent.messages).toHaveLength(2)
    expect(sent.messages[0].role).toBe("system")
    // The user's words travel verbatim — the title must reflect their request.
    expect(sent.messages[1].content).toBe("migra el esquema a Postgres")
  })

  test("the call is bounded and tells a reasoning model not to think", async () => {
    const sessionId = await sessionWithFirstMessage("arregla el login con OAuth")

    await nameSessionFromFirstMessage(sessionId)

    const sent = fake!.requests[0] as {
      max_tokens?: number
      chat_template_kwargs?: { enable_thinking?: boolean }
    }
    // Measured on Qwen3.6-35B-A3B through llm-api: without these, the model
    // spent 1228 tokens reasoning and returned an EMPTY answer after 22 s — and
    // the cap alone only made it fail sooner. With thinking off the same call
    // answers in 8 tokens and ~0.9 s. If this regresses, titles silently stop
    // appearing and every session keeps its 120-char provisional instead.
    expect(sent.max_tokens).toBe(64)
    expect(sent.chat_template_kwargs?.enable_thinking).toBe(false)
  })

  test("a provider error keeps the provisional title", async () => {
    fake!.stop()
    fake = startFakeModel(() => { throw new Error("upstream 500") })

    const message = "arregla el login con OAuth porque falla en Safari"
    const sessionId = await sessionWithFirstMessage(message)

    await nameSessionFromFirstMessage(sessionId)

    // Never an error string as a session name.
    expect(await titleOf(sessionId)).toBe(message.slice(0, 120))
  })

  test("a second task does not spend a second call", async () => {
    const message = "arregla el login con OAuth porque falla en Safari"
    const sessionId = await sessionWithFirstMessage(message)

    await nameSessionFromFirstMessage(sessionId)
    await nameSessionFromFirstMessage(sessionId)

    expect(fake!.turnCount()).toBe(1)
  })
})