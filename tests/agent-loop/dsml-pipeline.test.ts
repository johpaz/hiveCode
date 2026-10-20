/**
 * The DSML parser works on its own; this checks it through the real loop and provider stack.
 * A model that writes its call as text (instead of the structured `tool_calls`) must still get the
 * tool run. The text below is copied from a real deepseek-flash response (HIVE_LLM_RAW_LOG).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { runAgent, type StreamChunk } from "@johpaz/hivecode-core/agent/agent-loop"
import { MODEL_ID, PROVIDER_ID, SECRET_SERVICE, previousDbPath, seedFixture, startFakeModel, type FakeModel } from "../e2e/helpers"

const B = "｜｜"
const REAL_CALL =
  `<${B}DSML${B} calls>\n` +
  `<${B}DSML${B} invoke name="fs_read">\n` +
  `<${B}DSML${B} parameter name="path" string="true">notas.txt</${B}DSML${B} parameter>\n` +
  `<${B}DSML${B} parameter name="offset" string="false">0</${B}DSML${B} parameter>\n` +
  `<${B}DSML${B} parameter name="limit" string="false">40</${B}DSML${B} parameter>\n` +
  `</${B}DSML${B} invoke>\n` +
  `</${B}DSML${B} calls>`

let model: FakeModel | null = null
let workspace = ""

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-dsml-")), "hivedb")
  workspace = mkdtempSync(path.join(tmpdir(), "hivecode-dsml-ws-"))
  writeFileSync(path.join(workspace, "notas.txt"), "contenido de las notas\n")
  await Bun.secrets.set({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}`, value: "sk-e2e-fake" })
})

afterEach(async () => {
  await Bun.sleep(20)
  model?.stop()
  model = null
})

afterAll(async () => {
  closeHiveDb()
  try { await Bun.secrets.delete({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}` }) } catch { /* gone */ }
  if (previousDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousDbPath
})

async function run(agentId: string, thread: string, opts: { streaming?: boolean } = {}) {
  const chunks: StreamChunk[] = []
  for await (const chunk of runAgent({
    agentId, userMessage: "lee las notas", threadId: thread, workspace,
    // Giving the loop a token sink is what makes it use the provider's streaming path.
    ...(opts.streaming ? { onToken: () => {} } : {}),
  })) chunks.push(chunk)
  return {
    toolResults: chunks.flatMap(c => c.tools?.messages?.map((m: any) => String(m.content ?? "")) ?? []),
    texts: chunks.flatMap(c => c.agent?.messages?.map((m: any) => String(m.content ?? "")) ?? []),
    run: chunks.find(c => c.run)?.run,
  }
}

describe("a tool call written as DSML text runs through the real loop", () => {
  test("narration plus a call, as deepseek writes it", async () => {
    model = startFakeModel(turn => turn === 1
      ? { content: `Leo las notas primero.\n\n${REAL_CALL}` }
      : { content: "Listo: las notas dicen lo esperado." })
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults, texts, run: summary } = await run("builder", "t-dsml-narration")

    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toContain("contenido de las notas")
    expect(texts.join("\n")).not.toContain("DSML")
    expect(summary?.status).toBe("completed")
  })

  test("a call with no narration at all", async () => {
    model = startFakeModel(turn => turn === 1 ? { content: REAL_CALL } : { content: "Hecho." })
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults, run: summary } = await run("builder", "t-dsml-bare")

    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toContain("contenido de las notas")
    expect(summary?.status).toBe("completed")
  })
})

/** OpenAI-style SSE: the reply arrives as small deltas, which can cut the markup anywhere. */
function startStreamingModel(turns: string[], pieceSize: number) {
  let turn = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { stream?: boolean }
      const text = turns[Math.min(turn++, turns.length - 1)]
      const delta = (content: string) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
      if (!body.stream) {
        return Response.json({ id: "c", object: "chat.completion", model: MODEL_ID, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      }
      const pieces = Array.from(text).reduce<string[]>((acc, ch, i) => { if (i % pieceSize === 0) acc.push(""); acc[acc.length - 1] += ch; return acc }, [])
      const payload = pieces.map(delta).join("") +
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n` +
        "data: [DONE]\n\n"
      return new Response(payload, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

describe("the same call arriving as a stream", () => {
  for (const pieceSize of [1, 7, 40]) {
    test(`in pieces of ${pieceSize} characters`, async () => {
      const streaming = startStreamingModel([`Leo las notas primero.\n\n${REAL_CALL}`, "Listo."], pieceSize)
      model = { ...streaming, requests: [], turnCount: () => 0 } as unknown as FakeModel
      await seedFixture({ baseUrl: streaming.baseUrl })

      const { toolResults, texts, run: summary } = await run("builder", `t-dsml-stream-${pieceSize}`, { streaming: true })

      expect(toolResults, "la herramienta debe ejecutarse").toHaveLength(1)
      expect(toolResults[0]).toContain("contenido de las notas")
      expect(texts.join("\n")).not.toContain("DSML")
      expect(summary?.status).toBe("completed")
    })
  }
})

describe("a call written as text that cannot run", () => {
  // `invoke` never closes: nothing can be recovered from it, and the markup is removed from the text.
  const BROKEN = `<${B}DSML${B} calls>\n<${B}DSML${B} invoke name="fs_read">\n<${B}DSML${B} parameter name="path" string="true">notas.txt`

  test("the turn is not ended: the model is asked to repeat the call, and the second one runs", async () => {
    model = startFakeModel((turn, req) => {
      if (turn === 1) return { content: `Leo las notas.\n\n${BROKEN}` }
      if (turn === 2) {
        // The loop told it what went wrong.
        const last = String((req.messages.at(-1) as { content?: unknown }).content ?? "")
        expect(last).toContain("NO se ejecutó")
        return { content: "", toolCalls: [{ name: "fs_read", args: { path: "notas.txt" } }] }
      }
      return { content: "Listo: las notas dicen lo esperado." }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults, run: summary } = await run("builder", "t-dsml-broken")

    expect(model.turnCount()).toBe(3)
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toContain("contenido de las notas")
    expect(summary?.status).toBe("completed")
  })

  test("it gives up after two attempts instead of looping forever", async () => {
    model = startFakeModel(() => ({ content: BROKEN }))
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults } = await run("builder", "t-dsml-hopeless")

    expect(toolResults).toHaveLength(0)
    // 1 original + 2 re-asks; with no text to show, the loop's usual closing summary is the 4th.
    expect(model.turnCount()).toBe(4)
  })

  test("plain text answers are untouched", async () => {
    model = startFakeModel(() => ({ content: "Todo en orden." }))
    await seedFixture({ baseUrl: model.baseUrl })

    const { texts, run: summary } = await run("builder", "t-plain")

    expect(model.turnCount()).toBe(1)
    expect(texts.join("")).toContain("Todo en orden.")
    expect(summary?.status).toBe("completed")
  })
})

describe("an empty turn (no text, no call)", () => {
  test("is not the end of the run: the model is asked to continue, and does", async () => {
    model = startFakeModel((turn, req) => {
      if (turn === 1) return { content: "", toolCalls: [{ name: "fs_read", args: { path: "notas.txt" } }] }
      if (turn === 2) return { content: "" } // empty after a tool result
      if (turn === 3) {
        expect(String((req.messages.at(-1) as { content?: unknown }).content ?? "")).toContain("llegó vacía")
        return { content: "Las notas dicen lo esperado." }
      }
      return { content: "" }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { texts, run: summary } = await run("builder", "t-empty-recovers")

    expect(model.turnCount()).toBe(3)
    expect(texts.join("\n")).toContain("Las notas dicen lo esperado.")
    expect(summary?.status).toBe("completed")
    expect(summary?.blocker).toBeNull()
  })

  test("gives up after two re-asks instead of looping", async () => {
    model = startFakeModel(() => ({ content: "" }))
    await seedFixture({ baseUrl: model.baseUrl })

    const { run: summary } = await run("builder", "t-empty-hopeless")

    // 1 original + 2 re-asks; then the loop's usual closing summary pass (also empty) is the 4th.
    expect(model.turnCount()).toBe(4)
    expect(summary?.status).toBe("blocked")
    expect(summary?.blocker).toBe("model_returned_no_tool_calls_and_no_content")
  })
})

describe("HIVE_LLM_RAW_LOG records empty responses too", () => {
  const { mkdtempSync, readFileSync } = require("node:fs") as typeof import("node:fs")
  const { tmpdir } = require("node:os") as typeof import("node:os")
  const { join } = require("node:path") as typeof import("node:path")

  test("with the reason it stopped and how much it thought", async () => {
    const { logEmptyResponse } = await import("@johpaz/hivecode-core/agent/llm-providers/openai-compat-base")
    const file = join(mkdtempSync(join(tmpdir(), "hive-rawlog-")), "raw.jsonl")
    process.env.HIVE_LLM_RAW_LOG = file
    try {
      logEmptyResponse("deepseek", "m", "stop", 5400)
      const line = JSON.parse(readFileSync(file, "utf-8").trim())
      expect(line).toMatchObject({ empty: true, finishReason: "stop", reasoningChars: 5400, provider: "deepseek" })
    } finally {
      delete process.env.HIVE_LLM_RAW_LOG
    }
  })
})
