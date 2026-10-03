/**
 * Qué id de modelo viaja a cada provider. El catálogo prefija con "<provider>/" las
 * filas de providers que revenden el mismo modelo (opencode-go/…, hivecode-free/…)
 * y openai-compat-base lo quita antes de la petición. En NVIDIA, en cambio,
 * "nvidia/" es la organización de sus propios modelos: quitarlo manda un id que
 * NVIDIA no conoce (404, verificado 2026-09-10 con nvidia/nemotron-3-super-120b-a12b).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { NvidiaProvider } from "./nvidia"
import { HivecodeFreeProvider } from "./hivecode-free"
import { OpenCodeGoProvider } from "./opencode-go"
import type { LLMCallOptions } from "../llm-client"

const sent: string[] = []
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      sent.push((await req.json()).model)
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
})

afterAll(() => server.stop(true))

async function sentModel(provider: { call(options: LLMCallOptions): Promise<unknown> }, providerId: string, model: string): Promise<string> {
  const before = sent.length
  await provider.call({
    provider: providerId,
    model,
    apiKey: "test-key",
    baseUrl: `http://localhost:${server.port}/v1`,
    messages: [{ role: "user", content: "hola" }],
  } as LLMCallOptions)
  return sent[before]
}

describe("id de modelo que viaja al provider", () => {
  test("NVIDIA conserva la organización nvidia/ de sus propios modelos", async () => {
    expect(await sentModel(new NvidiaProvider(), "nvidia", "nvidia/nemotron-3-super-120b-a12b"))
      .toBe("nvidia/nemotron-3-super-120b-a12b")
  })

  test("NVIDIA deja intactos los modelos de otras organizaciones", async () => {
    expect(await sentModel(new NvidiaProvider(), "nvidia", "deepseek-ai/deepseek-v4-flash-0731"))
      .toBe("deepseek-ai/deepseek-v4-flash-0731")
  })

  test("hivecode-free quita su prefijo de catálogo y nada más", async () => {
    expect(await sentModel(new HivecodeFreeProvider(), "hivecode-free", "hivecode-free/nvidia/nemotron-3-super-120b-a12b"))
      .toBe("nvidia/nemotron-3-super-120b-a12b")
    expect(await sentModel(new HivecodeFreeProvider(), "hivecode-free", "hivecode-free/deepseek-ai/deepseek-v4-flash-0731"))
      .toBe("deepseek-ai/deepseek-v4-flash-0731")
  })

  test("OpenCode Go quita su prefijo de catálogo", async () => {
    expect(await sentModel(new OpenCodeGoProvider(), "opencode-go", "opencode-go/deepseek-v4-flash"))
      .toBe("deepseek-v4-flash")
  })
})
