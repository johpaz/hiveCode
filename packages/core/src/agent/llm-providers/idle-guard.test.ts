/**
 * A connection that goes silent must not hold an agent for the SDK's ten minutes. Tested against a local server so the
 * real SDK, real streaming and real aborts are involved.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { OpenCodeGoProvider } from "./opencode-go"
import type { LLMCallOptions } from "../llm-client"

const sse = (parts: string[]) => parts.map(p => `data: ${p}\n\n`).join("")
const chunk = (content: string, finish: string | null = null) =>
  JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })

let server: ReturnType<typeof Bun.serve>
let hits = 0
let mode: "silent-then-ok" | "always-silent" | "dies-midway" = "silent-then-ok"

beforeAll(() => {
  process.env.HIVECODE_LLM_IDLE_MS = "1000"
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch() {
      hits++
      const silent = mode === "always-silent" || (mode === "silent-then-ok" && hits === 1)
      if (silent) return new Response(new ReadableStream({ start() { /* never writes */ } }), { headers: { "content-type": "text/event-stream" } })
      if (mode === "dies-midway") {
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse([chunk("hola")]))) } }), { headers: { "content-type": "text/event-stream" } })
      }
      return new Response(sse([chunk("ok"), chunk("", "stop"), "[DONE]"]), { headers: { "content-type": "text/event-stream" } })
    },
  })
})
afterEach(() => { hits = 0 })

const call = () => new OpenCodeGoProvider().call({
  provider: "opencode-go", model: "m", apiKey: "k", baseUrl: `http://localhost:${server.port}/v1`,
  messages: [{ role: "user", content: "hola" }], onToken: () => {},
} as LLMCallOptions)

describe("idle guard on streaming", () => {
  test("a silent connection is aborted and the request sent again", async () => {
    mode = "silent-then-ok"
    const response = await call()
    expect(response.content).toBe("ok")
    expect(hits).toBe(2)
  }, 15_000)

  test("a model that never answers fails after two retries instead of waiting forever", async () => {
    mode = "always-silent"
    await expect(call()).rejects.toThrow(/dejó de enviar datos/)
    expect(hits).toBe(3)
  }, 20_000)

  test("silence after the answer began is an error, not a replay", async () => {
    mode = "dies-midway"
    await expect(call()).rejects.toThrow(/a mitad de la respuesta/)
    expect(hits).toBe(1)
  }, 15_000)
})
