/**
 * compactThread en hilos largos y con traspaso estructurado.
 *
 * `getHistory()` devuelve los 200 mensajes MÁS ANTIGUOS: antes, la segunda compactación veía el mismo corte
 * que la primera y la compactación dejaba de avanzar pasado el mensaje ~200. Ahora lee solo lo posterior al
 * resumen previo, que entra por su traspaso. El modelo es un servidor local con el contrato de OpenAI; no se
 * escribe ninguna clave en el llavero.
 *
 * Run: bun test tests/compaction/long-thread.test.ts
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col, toIndexable } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { ensureHiveDb } from "@johpaz/hivecode-core/storage/bootstrap"
import { addMessage, getSummary, saveSummary } from "@johpaz/hivecode-core/agent/conversation-store"
import { compactThread, maybeCompact, resolveCompactionTrigger, transcriptLimits } from "@johpaz/hivecode-core/agent/compaction"
import { conversationReadTool } from "@johpaz/hivecode-core/tools/core"
import { compileContext } from "@johpaz/hivecode-core/agent/context-compiler"
import { ensureCoreAgentProfiles } from "@johpaz/hivecode-core/agent/agent-profiles"

const SECRET_SERVICE = "hive-code" // must match packages/core/src/storage/crypto.ts
const PROVIDER_ID = "hivecode-compaction-fake"
const MODEL_ID = "hivecode-compaction-model"
const THREAD = "hilo-largo"

const prompts: string[] = []
let reply: (n: number) => string = (n) =>
  JSON.stringify({ objective: "conversación larga", facts: [`compactación número ${n}`], changes: [], verification: [], dead_ends: [], plan: [] })
let fail = false

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { messages: Array<{ content: unknown }> }
    prompts.push(String(body.messages[body.messages.length - 1]!.content))
    if (fail) return new Response("boom", { status: 500 })
    return Response.json({
      id: "c", object: "chat.completion", created: 1, model: MODEL_ID,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: reply(prompts.length) } }],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
    })
  },
})

const previousDbPath = process.env.HIVE_DB_PATH

async function seed() {
  const now = Math.floor(Date.now() / 1000)
  await (await col<any>("providers")).put(PROVIDER_ID, {
    id: PROVIDER_ID, user_id: "default", name: "Fake", enabled: true, active: true,
    base_url: `http://127.0.0.1:${server.port}/v1`, created_at: now, updated_at: now,
  })
  await (await col<any>("models")).put(MODEL_ID, {
    id: MODEL_ID, provider_id: PROVIDER_ID, name: MODEL_ID, context_window: 128_000, enabled: true, created_at: now, updated_at: now,
  })
  // La siembra ya trae un coordinador; es el que usa la compactación.
  const agents = await col<any>("agents")
  for (const e of await agents.findBy("role", "coordinator")) {
    await agents.put(e.id, { ...e.doc, provider_id: toIndexable(PROVIDER_ID), model_id: toIndexable(MODEL_ID) })
  }
}

async function agregar(desde: number, hasta: number) {
  for (let i = desde; i < hasta; i++) {
    await addMessage(THREAD, i % 2 === 0 ? "user" : "assistant", `mensaje ${i}`, { channel: "webchat" })
  }
}

beforeEach(async () => {
  prompts.length = 0
  fail = false
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-compaction-")), "hivedb")
  await Bun.secrets.set({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}`, value: "sk-compaction-fake" })
  await ensureHiveDb()
  await seed()
})

afterEach(() => closeHiveDb())

afterAll(async () => {
  server.stop(true)
  // Never leave test credentials behind in the OS keychain (only the fake provider's entry).
  try { await Bun.secrets.delete({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}` }) } catch { /* already gone */ }
  if (previousDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousDbPath
})

describe("compactThread en hilos largos", () => {
  test("sigue avanzando pasados los primeros 200 mensajes", async () => {
    await agregar(0, 250)
    await compactThread(THREAD)
    const primera = await getSummary(THREAD)
    expect(primera).not.toBeNull()

    await agregar(250, 450)
    await compactThread(THREAD)
    const segunda = await getSummary(THREAD)

    expect(segunda!.last_message_id).toBeGreaterThan(primera!.last_message_id)
    expect(segunda!.last_message_id).toBeGreaterThan(400)
    expect(prompts.length).toBe(2)
  })

  test("la segunda compactación incorpora el traspaso de la primera y solo lo nuevo", async () => {
    await agregar(0, 250)
    await compactThread(THREAD)
    await agregar(250, 450)
    await compactThread(THREAD)

    expect(prompts[1]).toContain("compactación número 1")
    expect(prompts[1]).not.toContain("mensaje 3\n")
  })

  test("guarda el traspaso de seis campos y su texto renderizado", async () => {
    await agregar(0, 30)
    await compactThread(THREAD)
    const s = await getSummary(THREAD)
    expect(s!.structured?.objective).toBe("conversación larga")
    expect(s!.structured?.facts).toEqual(["compactación número 1"])
    expect(s!.summary).toContain("compactación número 1")
  })

  test("messages_covered es acumulado", async () => {
    await agregar(0, 250)
    await compactThread(THREAD)
    const primera = await getSummary(THREAD)
    await agregar(250, 450)
    await compactThread(THREAD)
    const segunda = await getSummary(THREAD)
    expect(segunda!.messages_covered).toBe(primera!.messages_covered + (segunda!.last_message_id - primera!.last_message_id))
  })

  test("prosa en vez de JSON se guarda como resumen libre; un JSON roto no compacta", async () => {
    reply = () => "El usuario pidió migrar la facturación."
    await agregar(0, 30)
    await compactThread(THREAD)
    const libre = await getSummary(THREAD)
    expect(libre!.summary).toBe("El usuario pidió migrar la facturación.")
    expect(libre!.structured).toBeNull()

    reply = () => '{"objective": "roto", "facts": ['
    await agregar(30, 60)
    await compactThread(THREAD)
    expect((await getSummary(THREAD))!.last_message_id).toBe(libre!.last_message_id)
    reply = (n) => JSON.stringify({ objective: "conversación larga", facts: [`compactación número ${n}`], changes: [], verification: [], dead_ends: [], plan: [] })
  })

  test("si el modelo falla no se guarda el error como resumen", async () => {
    fail = true
    await agregar(0, 30)
    await compactThread(THREAD)
    expect(await getSummary(THREAD)).toBeNull()
  })

  test("un resumen anterior a `structured` sigue funcionando", async () => {
    await saveSummary(THREAD, "Resumen libre antiguo", 10, 10)
    await agregar(10, 40)
    await compactThread(THREAD)
    expect(prompts[0]).toContain("Resumen libre antiguo")
    expect((await getSummary(THREAD))!.structured).not.toBeNull()
  })

  test("maybeCompact no recompacta en cada turno si el historial vivo es corto", async () => {
    // Mensajes largos para superar el umbral de 6000 tokens con pocos mensajes.
    for (let i = 0; i < 40; i++) {
      await addMessage(THREAD, i % 2 === 0 ? "user" : "assistant", `mensaje ${i} ` + "palabra ".repeat(120), { channel: "webchat" })
    }
    await maybeCompact(THREAD, undefined, 24_000) // ventana de 24K → umbral de 6000
    expect(prompts.length).toBe(1)

    for (let i = 40; i < 46; i++) {
      await addMessage(THREAD, i % 2 === 0 ? "user" : "assistant", `corto ${i}`, { channel: "webchat" })
    }
    await maybeCompact(THREAD, undefined, 24_000)
    expect(prompts.length).toBe(1)
  })
})

describe("umbral de compactación según el ctx del modelo", () => {
  test("es la parte del espacio útil que puede ocupar el contexto total; al historial le toca lo que deja la parte fija", () => {
    // 128K × 0,8 de espacio útil × 0,8 = 81 920 de contexto total, menos 10 000 de parte fija supuesta.
    expect(resolveCompactionTrigger({ window: 128_000 })).toBe(71_920)
    expect(resolveCompactionTrigger({ window: 128_000, configured: 0.6 })).toBe(51_440)
    // Una parte fija medida mayor deja menos al historial.
    expect(resolveCompactionTrigger({ window: 128_000, fixedTokens: 25_000 })).toBe(56_920)
    expect(resolveCompactionTrigger({ window: 32_768 })).toBe(10_971)
  })

  test("un valor mayor que 1 son tokens de historial, sin más cálculo", () => {
    expect(resolveCompactionTrigger({ window: 128_000, configured: 20_000 })).toBe(20_000)
  })

  test("nunca por debajo de 2000 tokens ni por encima del 90 % del presupuesto de historial del compilador", () => {
    expect(resolveCompactionTrigger({ window: 8_192 })).toBe(2_000)
    // Con una parte fija enorme el presupuesto del compilador es pequeño: el umbral no lo pasa.
    expect(resolveCompactionTrigger({ window: 128_000, fixedTokens: 100_000 })).toBe(17_920)
    expect(resolveCompactionTrigger({ window: 128_000, configured: 1 })).toBeLessThanOrEqual(Math.floor(0.9 * (0.8 * 128_000 - 10_000)))
  })

  test("sin ventana conocida: 6000 por defecto, y una proporción se lee sobre 128K", () => {
    expect(resolveCompactionTrigger({})).toBe(6_000)
    expect(resolveCompactionTrigger({ configured: 0.6 })).toBe(51_440)
    expect(resolveCompactionTrigger({ configured: Number.NaN, window: 0 })).toBe(71_920)
  })

  test("la transcripción que ve el resumen crece con la ventana, con topes", () => {
    expect(transcriptLimits(undefined)).toEqual({ maxMsgs: 40, maxChars: 24_000 })
    expect(transcriptLimits(128_000)).toEqual({ maxMsgs: 74, maxChars: 44_800 })
    expect(transcriptLimits(1_000_000)).toEqual({ maxMsgs: 160, maxChars: 100_000 })
  })

  test("el mismo historial compacta en un modelo pequeño y no en uno grande", async () => {
    for (let i = 0; i < 40; i++) {
      await addMessage(THREAD, i % 2 === 0 ? "user" : "assistant", `mensaje ${i} ` + "palabra ".repeat(120), { channel: "webchat" })
    }
    await maybeCompact(THREAD, undefined, 128_000) // umbral ~72K: ~9,6K tokens no lo alcanzan
    expect(prompts.length).toBe(0)
    await maybeCompact(THREAD, undefined, 24_000) // umbral ~5,4K
    expect(prompts.length).toBe(1)
  })
})

describe("el resumen llega al modelo", () => {
  async function prompt() {
    await ensureCoreAgentProfiles()
    const compiled = await compileContext({ agentId: "bee", threadId: THREAD, userMessage: "sigue", isolated: false })
    return compiled.systemPrompt
  }

  test("se aplica cuando cubre mensajes que ya no están en la ventana", async () => {
    await agregar(0, 100) // la ventana trae los últimos 40: ids ~61-100
    await saveSummary(THREAD, "RESUMEN_DE_PRUEBA lo anterior", 60, 60)
    expect(await prompt()).toContain("RESUMEN_DE_PRUEBA")
  })

  test("carga conversation_read solo cuando el resumen aplica, y avisa dónde está el detalle", async () => {
    await ensureCoreAgentProfiles()
    await agregar(0, 100)
    await saveSummary(THREAD, "RESUMEN_DE_PRUEBA lo anterior", 60, 60)
    const withSummary = await compileContext({ agentId: "bee", threadId: THREAD, userMessage: "sigue", isolated: false })
    expect(withSummary.tools.map(t => t.function.name)).toContain("conversation_read")
    expect(withSummary.systemPrompt).toContain("hasta el #60")

    const other = await compileContext({ agentId: "bee", threadId: "hilo-sin-resumen", userMessage: "hola", isolated: false })
    expect(other.tools.map(t => t.function.name)).not.toContain("conversation_read")
  })

  test("no se duplica cuando la ventana aún contiene lo que cubre", async () => {
    await agregar(0, 30)
    await saveSummary(THREAD, "RESUMEN_DE_PRUEBA lo anterior", 10, 10)
    expect(await prompt()).not.toContain("RESUMEN_DE_PRUEBA")
  })
})

describe("conversation_read: el historial compactado sigue siendo recuperable", () => {
  const run = (threadId: string, params: Record<string, unknown>) =>
    conversationReadTool.execute(params, { configurable: { thread_id: threadId } } as any) as Promise<{ ok: boolean; messages: Array<{ id: number; content: string }> }>

  async function compactarConDato() {
    await addMessage(THREAD, "user", "El despliegue usa el puerto 8443 en producción", { channel: "webchat" })
    await agregar(1, 60)
    await compactThread(THREAD)
    await Bun.sleep(200) // el índice se escribe en segundo plano
  }

  test("encuentra por significado un dato que quedó fuera del resumen", async () => {
    await compactarConDato()
    expect((await getSummary(THREAD))!.summary).not.toContain("8443")
    const r = await run(THREAD, { query: "puerto despliegue producción" })
    expect(r.ok).toBe(true)
    expect(r.messages.some(m => m.content.includes("8443"))).toBe(true)
  })

  test("lee por id aunque el mensaje sea antiguo", async () => {
    await compactarConDato()
    const r = await run(THREAD, { message_ids: [1] })
    expect(r.messages.map(m => m.content)).toEqual(["El despliegue usa el puerto 8443 en producción"])
  })

  test("no cruza hilos", async () => {
    await compactarConDato()
    const r = await run("otro-hilo", { query: "puerto despliegue producción", message_ids: [1] })
    expect(r.messages).toEqual([])
  })

  test("pide al menos una de las tres cosas", async () => {
    expect((await run(THREAD, {})).ok).toBe(false)
  })
})
