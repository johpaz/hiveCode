import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const keys: Record<string, string | null> = {}
mock.module("../storage/crypto", () => ({
  getProviderApiKey: async (id: string) => keys[id] ?? null,
}))

const { closeHiveDb } = await import("../storage/hivedb.ts")
const { col } = await import("../storage/hive.ts")
const { ensureHiveDb } = await import("../storage/bootstrap.ts")
const { askJev, resolveOracles, resetJevStatus, getJevStatus } = await import("./jev-decisions.ts")
type ProviderDoc = import("../storage/collections.ts").ProviderDoc

const previousHiveDbPath = process.env.HIVE_DB_PATH

async function setProvider(id: string, patch: Partial<ProviderDoc>): Promise<void> {
  const providers = await col<ProviderDoc>("providers")
  const row = await providers.get(id)
  const doc = row?.doc ?? { id, name: id, base_url: null, category: "llm", num_ctx: null, num_gpu: 0, enabled: false, active: false, created_at: Date.now() }
  await providers.put(id, { ...doc, ...patch } as ProviderDoc, { expectedVersion: row?.version ?? 0 })
}

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-oracle-")), "hivedb")
  await ensureHiveDb()
  for (const id of Object.keys(keys)) delete keys[id]
  await setProvider("openrouter", { enabled: false, active: false })
  await setProvider("hiveagents", { enabled: false, active: false })
  resetJevStatus()
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

const QUESTIONS = { need: { type: "noul" as const, instructions: "Is it needed?" } }
const ok = (answer: unknown) => new Response(JSON.stringify({ answers: { need: answer } }), { status: 200 })

describe("oracle resolution: Jev, then Kev, then classic", () => {
  test("no provider active: no oracle and the classic path runs", async () => {
    keys.openrouter = "or-key"
    keys.hiveagents = "ha-key"
    expect(await resolveOracles()).toEqual([])
    expect(await askJev({}, QUESTIONS, { fetcher: (async () => { throw new Error("no network expected") }) as unknown as typeof fetch })).toBeNull()
    expect((await getJevStatus()).state).toBe("off")
  })

  test("only HiveAgents: Kev at /v1/systemone", async () => {
    keys.hiveagents = "ha-key"
    await setProvider("hiveagents", { enabled: true, active: true, base_url: "https://llm.example.io/v1" })
    const [oracle, ...rest] = await resolveOracles()
    expect(rest).toEqual([])
    expect(oracle).toMatchObject({ kind: "kev", endpoint: "https://llm.example.io/v1/systemone", model: "kev", selfHosted: true })
  })

  test("both configured: Jev has priority over Kev", async () => {
    keys.openrouter = "or-key"
    keys.hiveagents = "ha-key"
    await setProvider("openrouter", { enabled: true, active: true })
    await setProvider("hiveagents", { enabled: true, active: true })
    expect((await resolveOracles()).map(o => o.kind)).toEqual(["jev", "kev"])
    const urls: string[] = []
    const result = await askJev({}, QUESTIONS, {
      fetcher: (async (url: string) => { urls.push(url); return ok({ type: "noul", noul: 0.9 }) }) as unknown as typeof fetch,
    })
    expect(result?.oracle).toBe("jev")
    expect(urls).toEqual(["https://openrouter.ai/api/alpha/decisions"])
  })

  test("Jev fails: Kev answers, normalizing its probability shape, at no cost", async () => {
    keys.openrouter = "or-key"
    keys.hiveagents = "ha-key"
    await setProvider("openrouter", { enabled: true, active: true })
    await setProvider("hiveagents", { enabled: true, active: true })
    const result = await askJev({}, QUESTIONS, {
      fetcher: (async (url: string) =>
        url.includes("openrouter") ? new Response("down", { status: 500 }) : ok({ type: "noul", probability: 0.7 })) as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ oracle: "kev", costUsd: 0 })
    expect(result?.answers.need).toEqual({ type: "noul", noul: 0.7 })
    expect((await getJevStatus()).oracle).toBe("jev")
  })

  test("both fail: null, so the caller keeps the classic behavior", async () => {
    keys.openrouter = "or-key"
    keys.hiveagents = "ha-key"
    await setProvider("openrouter", { enabled: true, active: true })
    await setProvider("hiveagents", { enabled: true, active: true })
    const fetcher = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch
    expect(await askJev({}, QUESTIONS, { fetcher })).toBeNull()
  })

  test("Kev choice answers without confidence take the probability of the choice", async () => {
    keys.hiveagents = "ha-key"
    await setProvider("hiveagents", { enabled: true, active: true })
    const result = await askJev({}, { pick: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } } }, {
      fetcher: (async () => new Response(JSON.stringify({
        answers: { pick: { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.8 } } },
      }))) as unknown as typeof fetch,
    })
    expect(result?.answers.pick).toMatchObject({ choice: "b", confidence: 0.8 })
  })

  test("Kev is skipped, not asked, when the request exceeds its context budget", async () => {
    keys.hiveagents = "ha-key"
    await setProvider("hiveagents", { enabled: true, active: true })
    let called = false
    const result = await askJev({ history: "x".repeat(25_000) }, QUESTIONS, {
      fetcher: (async () => { called = true; return ok({ type: "noul", noul: 0.5 }) }) as unknown as typeof fetch,
    })
    expect(result).toBeNull()
    expect(called).toBe(false)
    expect((await getJevStatus()).state).toBe("ready")
  })
})
