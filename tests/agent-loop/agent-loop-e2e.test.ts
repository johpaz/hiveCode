/**
 * End-to-end tests for the harness agent loop (`runAgent`).
 *
 * Real code path, no mocks of hiveCode itself:
 *   runAgent → context-compiler → llm-client → OpenAI-compatible HTTP call
 *            → real native tool execution → real HiveDB writes → stream chunks
 *
 * The only substituted component is the model provider: a local Bun.serve
 * instance speaking the OpenAI `/chat/completions` contract, scripted per test.
 * That keeps the loop's control flow (tool cycles, ceilings, loop detection,
 * cancellation) deterministic and offline while still exercising a real HTTP
 * round-trip through the production provider stack.
 *
 * Run: bun test tests/agent-loop/agent-loop-e2e.test.ts
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { runAgent, runAgentIsolated, type StreamChunk } from "@johpaz/hivecode-core/agent/agent-loop"
import type { AgentRunDoc, ScratchpadDoc, ToolRunDoc } from "@johpaz/hivecode-core/storage/collections"

// ── Fake model server ─────────────────────────────────────────────────────────

type ChatRequest = { messages: Array<Record<string, unknown>>; tools?: unknown[] }
type ChatTurn = {
  content?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>
  usage?: { input: number; output: number }
  /** Override the reported finish_reason — llama.cpp/LM Studio say "stop" with tool calls. */
  finishReason?: string
}

/** Scripted OpenAI-compatible endpoint. `script` is called once per model turn. */
function startFakeModel(script: (turn: number, req: ChatRequest) => ChatTurn) {
  const requests: ChatRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 })
      }
      const body = (await req.json()) as ChatRequest
      requests.push(body)
      const turn = script(requests.length, body)
      const message: Record<string, unknown> = { role: "assistant", content: turn.content ?? "" }
      if (turn.toolCalls?.length) {
        message.tool_calls = turn.toolCalls.map((tc, i) => ({
          id: tc.id ?? `call_${requests.length}_${i}`,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }))
      }
      return Response.json({
        id: `chatcmpl-e2e-${requests.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [{
          index: 0,
          message,
          finish_reason: turn.finishReason ?? (turn.toolCalls?.length ? "tool_calls" : "stop"),
        }],
        usage: {
          prompt_tokens: turn.usage?.input ?? 10,
          completion_tokens: turn.usage?.output ?? 5,
          total_tokens: (turn.usage?.input ?? 10) + (turn.usage?.output ?? 5),
        },
      })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    turnCount: () => requests.length,
    stop: () => server.stop(true),
  }
}

// ── Fixture ───────────────────────────────────────────────────────────────────

const SECRET_SERVICE = "hive-code" // must match packages/core/src/storage/crypto.ts
const PROVIDER_ID = "hivecode-e2e-fake"
const MODEL_ID = "hivecode-e2e-model"
const AGENT_ID = "e2e-harness-agent"

/** Native tools that survive the context-compiler's minimal loadout filter. */
const MINIMAL_TOOLS = ["save_note", "notify", "report_progress", "search_knowledge"]

const previousDbPath = process.env.HIVE_DB_PATH
let model: ReturnType<typeof startFakeModel> | null = null

async function seedFixture(opts: {
  baseUrl: string
  maxIterations?: number
  maxInputTokens?: number
} ): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  await (await col<any>("providers")).put(PROVIDER_ID, {
    id: PROVIDER_ID, user_id: "default", name: "E2E Fake Provider",
    enabled: true, active: true, base_url: opts.baseUrl,
    created_at: now, updated_at: now,
  })
  await (await col<any>("models")).put(MODEL_ID, {
    id: MODEL_ID, provider_id: PROVIDER_ID, name: MODEL_ID,
    context_window: 128_000, enabled: true, created_at: now, updated_at: now,
  })
  await (await col<any>("agents")).put(AGENT_ID, {
    id: AGENT_ID, user_id: "default", name: "E2E Harness", description: null,
    system_prompt: "Eres el agente de pruebas E2E.", tone: null,
    role: "coordinator", agent_type: "bee", status: "idle", enabled: true,
    provider_id: PROVIDER_ID, model_id: MODEL_ID,
    tools_json: JSON.stringify(MINIMAL_TOOLS), skills_json: null, parent_id: "",
    max_iterations: opts.maxIterations ?? 20,
    ...(opts.maxInputTokens ? { max_input_tokens: opts.maxInputTokens } : {}),
    workspace: null, created_at: now, updated_at: now,
  })
}

/** Drains the loop into an array so assertions can inspect the whole stream. */
async function collect(
  gen: AsyncGenerator<StreamChunk>,
): Promise<{ chunks: StreamChunk[]; agentTexts: string[]; toolResults: string[]; run: StreamChunk["run"] }> {
  const chunks: StreamChunk[] = []
  for await (const chunk of gen) chunks.push(chunk)
  return {
    chunks,
    agentTexts: chunks.flatMap(c => c.agent?.messages?.map((m: any) => String(m.content ?? "")) ?? []),
    toolResults: chunks.flatMap(c => c.tools?.messages?.map((m: any) => String(m.content ?? "")) ?? []),
    run: chunks.find(c => c.run)?.run,
  }
}

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-loop-e2e-")), "hivedb")
  await Bun.secrets.set({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}`, value: "sk-e2e-fake" })
})

afterEach(() => {
  model?.stop()
  model = null
})

afterAll(async () => {
  closeHiveDb()
  // Never leave test credentials behind in the OS keychain.
  try { await Bun.secrets.delete({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}` }) } catch { /* already gone */ }
  if (previousDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousDbPath
})

// ── 1. Tool-call cycle ────────────────────────────────────────────────────────

describe("agent loop: tool-call cycle", () => {
  test("model requests a tool → loop executes it for real → result feeds the next turn", async () => {
    model = startFakeModel((turn) =>
      turn === 1
        ? { content: "Guardo la nota primero.", toolCalls: [{ name: "save_note", args: { key: "hallazgo-e2e", value: "hallazgo e2e" } }] }
        : { content: "Listo: la nota quedó guardada." },
    )
    await seedFixture({ baseUrl: model.baseUrl })

    const { agentTexts, toolResults, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "guarda una nota", threadId: "thread-tool-cycle",
    }))

    // Two model turns: the tool request and the final answer.
    expect(model.turnCount()).toBe(2)
    expect(agentTexts[0]).toContain("Guardo la nota")
    expect(agentTexts.at(-1)).toContain("la nota quedó guardada")

    // The tool actually ran and its result was streamed back.
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toContain("ok")
    expect(run?.status).toBe("completed")
    expect(run?.blocker).toBeNull()

    // The second model call carries the assistant tool_call + the tool result.
    const secondCall = model.requests[1]!
    const roles = secondCall.messages.map(m => m.role)
    expect(roles).toContain("assistant")
    expect(roles).toContain("tool")

    // Real side effect in HiveDB — not a stub.
    const notes = await (await col<ScratchpadDoc>("scratchpad")).scan()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.doc.key).toBe("hallazgo-e2e")
    expect(notes[0]!.doc.value).toBe("hallazgo e2e")
    expect(notes[0]!.doc.thread_id).toBe("thread-tool-cycle")
  })

  test("tool telemetry is persisted with the run and marked as a DB mutation", async () => {
    model = startFakeModel((turn) =>
      turn === 1
        ? { content: "", toolCalls: [{ name: "save_note", args: { key: "telemetria", value: "dato" } }] }
        : { content: "Hecho." },
    )
    await seedFixture({ baseUrl: model.baseUrl })

    await collect(runAgent({ agentId: AGENT_ID, userMessage: "nota", threadId: "thread-telemetry" }))

    const toolRuns = await (await col<ToolRunDoc>("toolRuns")).scan()
    expect(toolRuns).toHaveLength(1)
    const doc = toolRuns[0]!.doc
    expect(doc.tool_name).toBe("save_note")
    expect(doc.status).toBe("completed")
    expect(doc.mutates_db).toBe(true)
    expect(doc.mutates_workspace).toBe(false)
    expect(doc.duration_ms).not.toBeNull()
  })

  test("a tool the agent does not have is reported back instead of throwing", async () => {
    model = startFakeModel((turn) =>
      turn === 1
        // Hallucinated tool name — not in the agent's capability envelope.
        ? { content: "", toolCalls: [{ name: "herramienta_inexistente", args: { x: 1 } }] }
        : { content: "Esa herramienta no existe, informo al usuario." },
    )
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "usa una herramienta inventada", threadId: "thread-tool-error",
    }))

    // The loop feeds the error back to the model rather than throwing.
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toContain("not found")
    expect(model.turnCount()).toBe(2)
    expect(run?.status).toBe("completed")
  })

  test("save_note rejects missing args instead of storing an empty note", async () => {
    // Regression guard: `save_note` used to accept anything, writing a junk row
    // keyed "<thread>:undefined" while answering "Note saved.". A model that
    // guesses the argument names must now get a real error it can recover from.
    model = startFakeModel((turn) =>
      turn === 1
        ? { content: "", toolCalls: [{ name: "save_note", args: { content: "texto con el nombre equivocado" } }] }
        : { content: "Corrijo los argumentos e informo al usuario." },
    )
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "guarda una nota", threadId: "thread-badargs",
    }))

    // The failure is reported back to the model…
    expect(toolResults[0]).toContain("save_note requires")

    // …and nothing was written.
    expect(await (await col<ScratchpadDoc>("scratchpad")).scan()).toHaveLength(0)
  })

  test("a rejected tool call is recorded as failed telemetry", async () => {
    model = startFakeModel((turn) =>
      turn === 1
        ? { content: "", toolCalls: [{ name: "save_note", args: { key: "  ", value: "algo" } }] }
        : { content: "Listo." },
    )
    await seedFixture({ baseUrl: model.baseUrl })

    await collect(runAgent({
      agentId: AGENT_ID, userMessage: "clave en blanco", threadId: "thread-blankkey",
    }))

    const toolRuns = await (await col<ToolRunDoc>("toolRuns")).scan()
    expect(toolRuns).toHaveLength(1)
    expect(toolRuns[0]!.doc.status).toBe("failed")
    expect(toolRuns[0]!.doc.error).toContain("save_note requires")
  })
})

// ── 2. Step ceiling ───────────────────────────────────────────────────────────

describe("agent loop: step ceiling", () => {
  test("maxSteps stops a model that never stops calling tools", async () => {
    let synthesisCall = -1
    model = startFakeModel((turn, req) => {
      // The synthesis call is the one made without tools.
      if (!req.tools) { synthesisCall = turn; return { content: "Resumen: me quedé sin pasos." } }
      return { content: "", toolCalls: [{ name: "report_progress", args: { message: `paso ${turn}` } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { run, agentTexts } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "trabaja sin parar", threadId: "thread-max-steps",
      maxSteps: 3,
    }))

    expect(run?.status).toBe("needs_budget")
    expect(run?.blocker).toBe("max_steps:3")

    // 3 loop iterations + 1 synthesis call, and the synthesis ran last.
    expect(model.turnCount()).toBe(4)
    expect(synthesisCall).toBe(4)
    expect(agentTexts.at(-1)).toContain("me quedé sin pasos")

    const runs = await (await col<AgentRunDoc>("agentRuns")).scan()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.doc.status).toBe("needs_budget")
    expect(runs[0]!.doc.max_turns).toBe(3)
  })

  test("the budget ceiling stops the loop before the step ceiling", async () => {
    model = startFakeModel(() => ({
      content: "", toolCalls: [{ name: "report_progress", args: { message: "sigo" } }],
      usage: { input: 5_000, output: 100 },
    }))
    await seedFixture({ baseUrl: model.baseUrl, maxInputTokens: 6_000 })

    const { run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "consume presupuesto", threadId: "thread-budget",
      maxSteps: 50,
    }))

    expect(run?.status).toBe("needs_budget")
    expect(run?.blocker).toBe("max_input_tokens:6000")
    // Stopped on budget (2 turns), nowhere near the 50-step ceiling.
    expect(model!.turnCount()).toBeLessThan(6)
  })
})

// ── 3. Loop detection ─────────────────────────────────────────────────────────

describe("agent loop: repeated-call detection", () => {
  test("the same tool with the same args in a row is broken as a stall", async () => {
    model = startFakeModel((_turn, req) => {
      if (!req.tools) return { content: "No logré avanzar." }
      // Identical name + identical arguments every turn.
      return { content: "", toolCalls: [{ name: "report_progress", args: { message: "idéntico" } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "repite la misma llamada", threadId: "thread-repeat",
      maxSteps: 30,
    }))

    expect(run?.status).toBe("blocked")
    expect(run?.blocker).toBe("repeated_tool_call:report_progress")
    // Broken at the repeat limit, far below maxSteps.
    expect(model!.turnCount()).toBeLessThanOrEqual(6)
  })

  test("varying the arguments does not trip the stall detector", async () => {
    model = startFakeModel((turn, req) => {
      if (!req.tools) return { content: "fin" }
      return turn < 4
        ? { content: "", toolCalls: [{ name: "report_progress", args: { message: `paso distinto ${turn}` } }] }
        : { content: "Progreso real, termino." }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { run, agentTexts } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "avanza de verdad", threadId: "thread-progress",
      maxSteps: 30,
    }))

    expect(run?.status).toBe("completed")
    expect(run?.blocker).toBeNull()
    expect(agentTexts.at(-1)).toContain("Progreso real")
  })
})

// ── 4. Cancellation ───────────────────────────────────────────────────────────

describe("agent loop: cancellation", () => {
  test("an aborted signal stops the loop and reports the cancellation", async () => {
    const controller = new AbortController()
    model = startFakeModel((turn, req) => {
      if (!req.tools) return { content: "Cancelado." }
      // Abort after the first tool round-trip.
      if (turn === 1) queueMicrotask(() => controller.abort())
      return { content: "", toolCalls: [{ name: "report_progress", args: { message: `t${turn}` } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "te voy a cancelar", threadId: "thread-abort",
      maxSteps: 30, signal: controller.signal,
    }))

    expect(run?.status).toBe("cancelled")
    expect(run?.blocker).toBe("aborted_by_signal")
    // Cancelled early — nowhere near the ceiling.
    expect(model!.turnCount()).toBeLessThan(5)
  })

  test("a signal already aborted stops before any model call", async () => {
    model = startFakeModel(() => ({ content: "no debería llamarse" }))
    await seedFixture({ baseUrl: model.baseUrl })

    const { run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "cancelado de entrada", threadId: "thread-preaborted",
      signal: AbortSignal.abort(),
    }))

    expect(run?.status).toBe("cancelled")
    expect(run?.blocker).toBe("aborted_by_signal")
    // Synthesis still runs (the loop had no final text), but no *loop* turn did.
    expect(model!.requests.every(r => !r.tools)).toBe(true)
  })
})

// ── 5. Token streaming ────────────────────────────────────────────────────────

describe("agent loop: token streaming", () => {
  test("onToken receives the answer incrementally and reassembles it", async () => {
    // The fake server streams SSE the way an OpenAI-compatible provider does.
    const pieces = ["Voy ", "a ", "responder ", "por ", "partes."]
    const server = Bun.serve({
      port: 0,
      fetch() {
        const body = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            for (const piece of pieces) {
              controller.enqueue(enc.encode(
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`,
              ))
            }
            controller.enqueue(enc.encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            ))
            controller.enqueue(enc.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    model = {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      requests: [], turnCount: () => 0, stop: () => server.stop(true),
    } as unknown as ReturnType<typeof startFakeModel>
    await seedFixture({ baseUrl: model.baseUrl })

    const tokens: string[] = []
    const { run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "responde en streaming", threadId: "thread-streaming",
      onToken: (token) => { tokens.push(token) },
    }))

    // Arrived piece by piece, not as one blob.
    expect(tokens.length).toBeGreaterThan(1)
    expect(tokens.join("")).toBe(pieces.join(""))
    expect(run?.status).toBe("completed")
  })
})

// ── 6. Provider failure ───────────────────────────────────────────────────────

describe("agent loop: provider failure", () => {
  test("an upstream 500 fails the run instead of passing as a normal answer", async () => {
    // `callLLM` catches provider errors and returns them as "[LLM Error] …"
    // content. The loop must not mistake that for the model's final answer.
    const server = Bun.serve({ port: 0, fetch: () => new Response("upstream boom", { status: 500 }) })
    model = {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      requests: [], turnCount: () => 0, stop: () => server.stop(true),
    } as unknown as ReturnType<typeof startFakeModel>
    await seedFixture({ baseUrl: model.baseUrl })

    const { agentTexts, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "el proveedor está caído", threadId: "thread-provider-down",
    }))

    expect(agentTexts.at(-1)).toContain("[LLM Error]")
    expect(run?.status).toBe("failed")
    expect(run?.blocker).toContain("[LLM Error]")

    // The failure is durable, so a supervisor can act on it.
    const runs = await (await col<AgentRunDoc>("agentRuns")).scan()
    expect(runs[0]!.doc.status).toBe("failed")
  })

  test("aborting mid-call cancels the in-flight request, not just the next turn", async () => {
    const controller = new AbortController()
    let sawAbort = false
    // A server that never answers: only signal propagation can end this call.
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        queueMicrotask(() => controller.abort())
        return await new Promise<Response>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")) })
        })
      },
    })
    model = {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      requests: [], turnCount: () => 0, stop: () => server.stop(true),
    } as unknown as ReturnType<typeof startFakeModel>
    await seedFixture({ baseUrl: model.baseUrl })

    const { run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "cancélame a mitad", threadId: "thread-inflight-abort",
      signal: controller.signal,
    }))

    // The server observed the client hang up — the abort reached the socket.
    expect(sawAbort).toBe(true)
    expect(run?.status).not.toBe("completed")
  })
})

// ── 8. Provider contract deviations ───────────────────────────────────────────
//
// Local runtimes (llama.cpp, LM Studio) deviate from the OpenAI contract in ways
// that used to make the loop stop on its first turn. These pin the recoveries.

describe("agent loop: provider contract deviations", () => {
  test('native tool calls reported with finish_reason "stop" are still executed', async () => {
    model = startFakeModel((turn) =>
      turn === 1
        ? {
          content: "Guardo la nota.",
          toolCalls: [{ name: "save_note", args: { key: "finish-stop", value: "ejecutada" } }],
          // The deviation: tool calls present, but the server says "stop".
          finishReason: "stop",
        }
        : { content: "Nota guardada." },
    )
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "guarda una nota", threadId: "thread-finish-stop",
    }))

    // Two turns means the tool ran and fed a second call — not a one-turn stop.
    expect(model.turnCount()).toBe(2)
    expect(toolResults).toHaveLength(1)
    expect(run?.status).toBe("completed")

    const notes = await (await col<ScratchpadDoc>("scratchpad")).scan()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.doc.key).toBe("finish-stop")
  })

  test("tool calls embedded in the text as <tool_call> are recovered and executed", async () => {
    model = startFakeModel((turn) =>
      turn === 1
        ? {
          // Qwen emits this shape when it does not use the native tool_calls field.
          content: 'Voy a guardarlo.\n<tool_call>{"name": "save_note", "arguments": {"key": "desde-texto", "value": "extraida"}}</tool_call>',
        }
        : { content: "Listo." },
    )
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "guarda una nota", threadId: "thread-text-toolcall",
    }))

    expect(model.turnCount()).toBe(2)
    expect(toolResults).toHaveLength(1)
    expect(run?.status).toBe("completed")

    const notes = await (await col<ScratchpadDoc>("scratchpad")).scan()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.doc.key).toBe("desde-texto")
    expect(notes[0]!.doc.value).toBe("extraida")
  })

  test("streaming deltas without index or id keep their calls separate", async () => {
    // llama.cpp --jinja frequently omits both. Collapsing them concatenated the
    // argument fragments into unparseable JSON.
    let call = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        call++
        const enc = new TextEncoder()
        const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`)
        const body = new ReadableStream({
          start(controller) {
            if (call === 1) {
              // Two distinct tool calls, no `index`, no `id`, arguments split across chunks.
              controller.enqueue(sse({ choices: [{ delta: { tool_calls: [{ function: { name: "save_note", arguments: '{"key":"uno",' } }] } }] }))
              controller.enqueue(sse({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"value":"primera"}' } }] } }] }))
              controller.enqueue(sse({ choices: [{ delta: { tool_calls: [{ function: { name: "save_note", arguments: '{"key":"dos","value":"segunda"}' } }] } }] }))
              controller.enqueue(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }))
            } else {
              controller.enqueue(sse({ choices: [{ delta: { content: "Ambas guardadas." } }] }))
              controller.enqueue(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }))
            }
            controller.enqueue(enc.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    model = {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      requests: [], turnCount: () => call, stop: () => server.stop(true),
    } as unknown as ReturnType<typeof startFakeModel>
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "guarda dos notas", threadId: "thread-no-index",
      onToken: () => { /* streaming path requires a token sink */ },
    }))

    // Both calls survived as separate calls with parseable arguments.
    expect(toolResults).toHaveLength(2)
    expect(run?.status).toBe("completed")

    const notes = await (await col<ScratchpadDoc>("scratchpad")).scan()
    const keys = notes.map(n => n.doc.key).sort()
    expect(keys).toEqual(["dos", "uno"])
    expect(notes.find(n => n.doc.key === "uno")!.doc.value).toBe("primera")
  })
})

// ── 9. Repetition: nudge before breaking ──────────────────────────────────────

describe("agent loop: repetition nudge", () => {
  test("a tool repeated with varying args is nudged, then stopped as a stall", async () => {
    // The exact shape that used to burn a whole budget silently: same tool, a
    // slightly different payload each time, so no two signatures ever matched.
    model = startFakeModel((turn, req) => {
      if (!req.tools) return { content: "No conseguí avanzar." }
      return { content: "", toolCalls: [{ name: "save_note", args: { key: `progreso-${turn}`, value: `avance ${turn}` } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { toolResults, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "repite notas de progreso", threadId: "thread-varying-stall",
      maxSteps: 30,
    }))

    // The corrective notice reached the model before the run was cut.
    expect(toolResults.some(r => r.includes("AVISO DEL HARNESS"))).toBe(true)
    expect(run?.status).toBe("blocked")
    expect(run?.blocker).toBe("repeated_tool_call:save_note")
    // Stopped on tool dominance, far below maxSteps.
    expect(model!.turnCount()).toBeLessThanOrEqual(8)
  })

  test("a stalled run still returns the synthesis summary to its caller", async () => {
    model = startFakeModel((_turn, req) => {
      if (!req.tools) return { content: "Resumen: quedé bloqueado repitiendo save_note." }
      return { content: "", toolCalls: [{ name: "report_progress", args: { message: "igual" } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { agentTexts, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "trábate", threadId: "thread-stall-synthesis",
      maxSteps: 30,
    }))

    expect(run?.status).toBe("blocked")
    // The user gets the summary, not a bare status.
    expect(agentTexts.at(-1)).toContain("quedé bloqueado")
  })
})

// ── 10. Loadout by role ───────────────────────────────────────────────────────

describe("agent loop: loadout by role", () => {
  /** Tool names the loop actually advertised to the model on a given turn. */
  const advertised = (req: ChatRequest): string[] =>
    (req.tools ?? []).map((t: any) => t.function?.name).sort()

  test("the coordinator gets the minimal set, a specialist gets its own envelope", async () => {
    const BUILDER_TOOLS = ["fs_read", "fs_write", "fs_list", "code_test", "save_note"]

    model = startFakeModel(() => ({ content: "listo" }))
    await seedFixture({ baseUrl: model.baseUrl })

    // Same fixture, but a specialist profile with a curated envelope.
    const now = Math.floor(Date.now() / 1000)
    await (await col<any>("agents")).put("e2e-builder", {
      id: "e2e-builder", user_id: "default", name: "E2E Builder", description: null,
      system_prompt: "Eres el builder de pruebas.", tone: null,
      role: "worker", agent_type: "builder", status: "idle", enabled: true,
      provider_id: PROVIDER_ID, model_id: MODEL_ID,
      tools_json: JSON.stringify(BUILDER_TOOLS), skills_json: null, parent_id: "",
      max_iterations: 20, workspace: null, created_at: now, updated_at: now,
    })

    await collect(runAgent({
      agentId: AGENT_ID, userMessage: "hola", threadId: "thread-loadout-bee",
    }))
    const beeTools = advertised(model.requests[0]!)

    await collect(runAgent({
      agentId: "e2e-builder", userMessage: "hola", threadId: "thread-loadout-builder",
    }))
    const builderTools = advertised(model.requests[1]!)

    // The coordinator orchestrates: minimal set only, no filesystem access.
    expect(beeTools).not.toContain("fs_write")
    expect(beeTools).toContain("search_knowledge")

    // The specialist arrives with the tools its job needs, without having to
    // discover them through search_knowledge first.
    expect(builderTools).toContain("fs_write")
    expect(builderTools).toContain("fs_read")
    expect(builderTools).toContain("code_test")
  })
})

// ── 11. Partial results ───────────────────────────────────────────────────────

describe("agent loop: partial results", () => {
  test("runAgentIsolated returns the synthesis summary instead of throwing on needs_budget", async () => {
    model = startFakeModel((_turn, req) => {
      if (!req.tools) return { content: "Resumen: avancé a medias, falta cerrar el plan." }
      return { content: "", toolCalls: [{ name: "report_progress", args: { message: `paso ${Math.random()}` } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    // Previously this threw "Agent … ended with needs_budget: max_steps:2" and the
    // summary the model had already written was discarded.
    const output = await runAgentIsolated({
      agentId: AGENT_ID,
      taskDescription: "trabaja sin parar",
      threadId: "thread-partial-result",
      maxSteps: 2,
    })

    expect(output).toContain("avancé a medias")

    // The degraded status is still recorded for observability.
    const runs = await (await col<AgentRunDoc>("agentRuns")).scan()
    expect(runs[0]!.doc.status).toBe("needs_budget")
    expect(runs[0]!.doc.blocker).toBe("max_steps:2")
  })

  test("a genuine failure still throws", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) })
    model = {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      requests: [], turnCount: () => 0, stop: () => server.stop(true),
    } as unknown as ReturnType<typeof startFakeModel>
    await seedFixture({ baseUrl: model.baseUrl })

    await expect(runAgentIsolated({
      agentId: AGENT_ID,
      taskDescription: "el proveedor está caído",
      threadId: "thread-partial-failure",
    })).rejects.toThrow(/ended with failed/)
  })
})
