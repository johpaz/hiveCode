/**
 * Against a local server that speaks Gemini's streaming protocol, so the real SDK parses real chunks.
 * Two things went unnoticed: the streaming usage was read from the wrong object (always 0, so the loop fell back
 * to an estimate), and a silent connection was never cut.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { GeminiProvider } from "./gemini"
import type { LLMCallOptions } from "../llm-client"

const enc = new TextEncoder()
const event = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`)
const part = (text: string, extra: object = {}) => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, ...extra }] })

let server: ReturnType<typeof Bun.serve>
let hits = 0
let lastBody: any
let mode: "usage" | "silent-then-ok" | "dies-midway" = "usage"

beforeAll(() => {
  process.env.HIVECODE_LLM_IDLE_MS = "1000"
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      hits++
      lastBody = await req.json().catch(() => undefined)
      const headers = { "content-type": "text/event-stream" }
      if (mode === "silent-then-ok" && hits === 1) return new Response(new ReadableStream({ start() { /* never writes */ } }), { headers })
      if (mode === "dies-midway") return new Response(new ReadableStream({ start(c) { c.enqueue(event(part("hola"))) } }), { headers })
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(event(part("ho")))
          c.enqueue(event({ ...part("la", { finishReason: "STOP" }), usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20, thoughtsTokenCount: 300, cachedContentTokenCount: 600, totalTokenCount: 1320 } }))
          c.close()
        },
      }), { headers })
    },
  })
})
afterAll(() => { server.stop(true); delete process.env.HIVECODE_LLM_IDLE_MS })
afterEach(() => { hits = 0 })

const call = () => new GeminiProvider().call({
  provider: "gemini", model: "gemini-3.8-flash", apiKey: "k", baseUrl: `http://localhost:${server.port}`,
  messages: [{ role: "user", content: "hola" }], onToken: () => {},
} as LLMCallOptions)

describe("gemini streaming", () => {
  test("reads the usage from the chunks: prompt, thinking counted as output, and the cached part", async () => {
    mode = "usage"
    const response = await call()
    expect(response.content).toBe("hola")
    expect(response.usage).toEqual({ input_tokens: 1000, output_tokens: 320, thinking_tokens: 300, cached_tokens: 600 })
  })

  test("the reasoning policy reaches Gemini 3 as its thinking level", async () => {
    mode = "usage"
    await new GeminiProvider().call({
      provider: "gemini", model: "gemini-3.8-flash", apiKey: "k", baseUrl: `http://localhost:${server.port}`,
      messages: [{ role: "user", content: "hola" }], onToken: () => {}, reasoningEffort: "low",
    } as LLMCallOptions)
    expect(lastBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" })
    await call()
    expect(lastBody.generationConfig.thinkingConfig).toBeUndefined()
  })

  test("a silent connection is aborted and the request sent again", async () => {
    mode = "silent-then-ok"
    expect((await call()).content).toBe("hola")
    expect(hits).toBe(2)
  }, 15_000)

  test("silence after the answer began is an error, not a replay", async () => {
    mode = "dies-midway"
    await expect(call()).rejects.toThrow(/a mitad de la respuesta/)
    expect(hits).toBe(1)
  }, 15_000)
})
