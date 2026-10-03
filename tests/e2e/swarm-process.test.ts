/**
 * End-to-end tests for the full swarm process:
 *
 *   TUI submit → CoordinatorManager.runTask → ProfileHarness
 *     → BEE classifies → Scout/Builder/Verifier/Reviewer execute
 *     → real native tool execution → real HiveDB writes → stream chunks
 *
 * The only substituted component is the model provider (see helpers.ts).
 *
 * Run: bun test --tsconfig-override tests/tsconfig.json tests/e2e/swarm-process.test.ts
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeNarrativeDoc, CodeTaskDoc, HarnessTaskDoc, ScratchpadDoc } from "@johpaz/hivecode-core/storage/collections"
import { runAgent, type StreamChunk } from "@johpaz/hivecode-core/agent/agent-loop"
import {
  AGENT_ID, MODEL_ID, PROVIDER_ID, isolateHiveDb, seedApiKey, seedFixture, cleanupApiKey, restoreDbPath,
  startFakeModel, type FakeModel,
} from "./helpers"

// ── Helpers ────────────────────────────────────────────────────────────────────

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

let model: FakeModel | null = null

beforeEach(async () => {
  isolateHiveDb()
  await seedApiKey()
})

afterEach(() => {
  model?.stop()
  model = null
})

afterAll(async () => {
  restoreDbPath()
  await cleanupApiKey()
})

// ── 1. BEE classification: respond ─────────────────────────────────────────────

describe("e2e swarm: BEE classification → respond", () => {
  test("a greeting is answered directly without activating workers", async () => {
    model = startFakeModel(() => ({ content: "¡Hola! Soy BEE. ¿En qué puedo ayudarte?" }))
    await seedFixture({ baseUrl: model.baseUrl })

    const { agentTexts, run, toolResults } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "hola", threadId: "thread-respond",
    }))

    expect(model.turnCount()).toBe(1)
    expect(agentTexts.at(-1)).toContain("¡Hola!")
    expect(run?.status).toBe("completed")
    expect(run?.blocker).toBeNull()
    // No tools were called — BEE answered directly.
    expect(toolResults).toHaveLength(0)

    // The turn was persisted in HiveDB as conversation history. codeTurns is not
    // the right place to look: only the TUI/coordinator Scribe writes it
    // (packages/code/src/narrative/scribe.ts), and this test drives runAgent.
    const messages = (await (await col<any>("conversations")).scan({ prefix: "thread-respond:" })).map((e: any) => e.doc)
    expect(messages.some((m: any) => m.role === "user" && m.content === "hola")).toBe(true)
    expect(messages.some((m: any) => m.role === "assistant" && String(m.content).includes("¡Hola!"))).toBe(true)
  })
})

// ── 2. BEE classification: fix (single tool cycle) ────────────────────────────

describe("e2e swarm: BEE → fix with real tool", () => {
  test("BEE saves a note via save_note and reports success", async () => {
    model = startFakeModel((turn) =>
      turn === 1
        ? { content: "Voy a guardar la nota.", toolCalls: [{ name: "save_note", args: { key: "fix-e2e", value: "nota del fix" } }] }
        : { content: "Listo: la nota quedó guardada." },
    )
    await seedFixture({ baseUrl: model.baseUrl })

    const { agentTexts, toolResults, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "guarda una nota", threadId: "thread-fix",
    }))

    expect(model.turnCount()).toBe(2)
    expect(agentTexts[0]).toContain("Voy a guardar")
    expect(agentTexts.at(-1)).toContain("quedó guardada")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toContain("ok")
    expect(run?.status).toBe("completed")

    // Real side effect in HiveDB.
    const notes = await (await col<ScratchpadDoc>("scratchpad")).scan()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.doc.key).toBe("fix-e2e")
    expect(notes[0]!.doc.value).toBe("nota del fix")
    expect(notes[0]!.doc.thread_id).toBe("thread-fix")
  })
})

// ── 3. Multi-turn tool cycle (dispatch-like flow) ─────────────────────────────

describe("e2e swarm: multi-turn tool cycle", () => {
  test("BEE chains two tools and synthesises a final answer", async () => {
    model = startFakeModel((turn) => {
      if (turn === 1) return { content: "Primero guardo una nota.", toolCalls: [{ name: "save_note", args: { key: "paso-1", value: "datos del paso 1" } }] }
      if (turn === 2) return { content: "Ahora guardo otra.", toolCalls: [{ name: "save_note", args: { key: "paso-2", value: "datos del paso 2" } }] }
      return { content: "Completé ambos pasos. Las notas están guardadas." }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { agentTexts, toolResults, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "ejecuta dos pasos", threadId: "thread-multi-tool",
    }))

    expect(model.turnCount()).toBe(3)
    expect(toolResults).toHaveLength(2)
    expect(agentTexts.at(-1)).toContain("ambos pasos")
    expect(run?.status).toBe("completed")

    const notes = await (await col<ScratchpadDoc>("scratchpad")).scan()
    const keys = notes.map(n => n.doc.key).sort()
    expect(keys).toEqual(["paso-1", "paso-2"])
  })
})

// ── 4. Step ceiling (budget enforcement) ───────────────────────────────────────

describe("e2e swarm: step ceiling", () => {
  test("maxSteps stops a model that never stops calling tools", async () => {
    let synthesisCall = -1
    model = startFakeModel((turn, req) => {
      if (!req.tools) { synthesisCall = turn; return { content: "Resumen: me quedé sin pasos." } }
      return { content: "", toolCalls: [{ name: "report_progress", args: { message: `paso ${turn}` } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { run, agentTexts } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "trabaja sin parar", threadId: "thread-ceiling",
      maxSteps: 3,
    }))

    expect(run?.status).toBe("needs_budget")
    expect(run?.blocker).toBe("max_steps:3")
    expect(model.turnCount()).toBe(4)
    expect(synthesisCall).toBe(4)
    expect(agentTexts.at(-1)).toContain("me quedé sin pasos")
  })
})

// ── 5. Loop detection (stall breaker) ──────────────────────────────────────────

describe("e2e swarm: stall detection", () => {
  test("the same tool with the same args is broken as a stall", async () => {
    model = startFakeModel((_turn, req) => {
      if (!req.tools) return { content: "No logré avanzar." }
      return { content: "", toolCalls: [{ name: "report_progress", args: { message: "idéntico" } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "repite la misma llamada", threadId: "thread-stall",
      maxSteps: 30,
    }))

    expect(run?.status).toBe("blocked")
    expect(run?.blocker).toBe("repeated_tool_call:report_progress")
    expect(model.turnCount()).toBeLessThanOrEqual(6)
  })
})

// ── 6. Cancellation ───────────────────────────────────────────────────────────

describe("e2e swarm: cancellation", () => {
  test("an aborted signal stops the loop and reports the cancellation", async () => {
    const controller = new AbortController()
    model = startFakeModel((turn, req) => {
      if (!req.tools) return { content: "Cancelado." }
      if (turn === 1) queueMicrotask(() => controller.abort())
      return { content: "", toolCalls: [{ name: "report_progress", args: { message: `t${turn}` } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const { run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "te voy a cancelar", threadId: "thread-cancel",
      maxSteps: 30, signal: controller.signal,
    }))

    expect(run?.status).toBe("cancelled")
    expect(run?.blocker).toBe("aborted_by_signal")
    expect(model.turnCount()).toBeLessThan(5)
  })
})

// ── 7. Provider failure propagation ───────────────────────────────────────────

describe("e2e swarm: provider failure", () => {
  test("an upstream 500 fails the run instead of passing as a normal answer", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("upstream boom", { status: 500 }) })
    model = {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      requests: [], turnCount: () => 0, stop: () => server.stop(true),
    } as unknown as FakeModel
    await seedFixture({ baseUrl: model.baseUrl })

    const { agentTexts, run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "el proveedor está caído", threadId: "thread-provider-down",
    }))

    expect(agentTexts.at(-1)).toContain("[LLM Error]")
    expect(run?.status).toBe("failed")
    expect(run?.blocker).toContain("[LLM Error]")
  })
})

// ── 8. Token streaming ────────────────────────────────────────────────────────

describe("e2e swarm: token streaming", () => {
  test("onToken receives the answer incrementally", async () => {
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
    } as unknown as FakeModel
    await seedFixture({ baseUrl: model.baseUrl })

    const tokens: string[] = []
    const { run } = await collect(runAgent({
      agentId: AGENT_ID, userMessage: "responde en streaming", threadId: "thread-stream",
      onToken: (token) => { tokens.push(token) },
    }))

    expect(tokens.length).toBeGreaterThan(1)
    expect(tokens.join("")).toBe(pieces.join(""))
    expect(run?.status).toBe("completed")
  })
})

// ── 9. Tool telemetry persistence ──────────────────────────────────────────────

describe("e2e swarm: tool telemetry", () => {
  test("tool runs are persisted with the run and marked as a DB mutation", async () => {
    model = startFakeModel((turn) =>
      turn === 1
        ? { content: "", toolCalls: [{ name: "save_note", args: { key: "telemetria", value: "dato" } }] }
        : { content: "Hecho." },
    )
    await seedFixture({ baseUrl: model.baseUrl })

    await collect(runAgent({ agentId: AGENT_ID, userMessage: "nota", threadId: "thread-telemetry" }))

    const toolRuns = await (await col<any>("toolRuns")).scan()
    expect(toolRuns).toHaveLength(1)
    const doc = toolRuns[0]!.doc
    expect(doc.tool_name).toBe("save_note")
    expect(doc.status).toBe("completed")
    expect(doc.mutates_db).toBe(true)
    expect(doc.duration_ms).not.toBeNull()
  })
})

// ── 10. Loadout by role ───────────────────────────────────────────────────────

describe("e2e swarm: loadout by role", () => {
  const advertised = (req: { tools?: unknown[] }): string[] =>
    (req.tools ?? []).map((t: any) => t.function?.name).sort()

  test("BEE gets the minimal set, Builder gets its own envelope", async () => {
    const BUILDER_TOOLS = ["fs_read", "fs_write", "fs_list", "code_test", "save_note"]
    model = startFakeModel(() => ({ content: "listo" }))
    await seedFixture({ baseUrl: model.baseUrl })

    // Seed a specialist builder profile.
    const now = Math.floor(Date.now() / 1000)
    await (await col<any>("agents")).put("e2e-builder", {
      id: "e2e-builder", user_id: "default", name: "E2E Builder", description: null,
      system_prompt: "Eres el builder de pruebas.", tone: null,
      role: "worker", agent_type: "builder", status: "idle", enabled: true,
      provider_id: PROVIDER_ID, model_id: MODEL_ID,
      tools_json: JSON.stringify(BUILDER_TOOLS), skills_json: null, parent_id: "",
      max_iterations: 20, workspace: null, created_at: now, updated_at: now,
    })

    await collect(runAgent({ agentId: AGENT_ID, userMessage: "hola", threadId: "thread-loadout-bee" }))
    const beeTools = advertised(model.requests[0]!)

    await collect(runAgent({ agentId: "e2e-builder", userMessage: "hola", threadId: "thread-loadout-builder" }))
    const builderTools = advertised(model.requests[1]!)

    expect(beeTools).not.toContain("fs_write")
    expect(beeTools).toContain("search_knowledge")
    expect(builderTools).toContain("fs_write")
    expect(builderTools).toContain("fs_read")
    expect(builderTools).toContain("code_test")
  })
})

// ── 11. Partial results (runAgentIsolated) ─────────────────────────────────────

describe("e2e swarm: partial results", () => {
  test("runAgentIsolated returns the synthesis summary instead of throwing on needs_budget", async () => {
    const { runAgentIsolated } = await import("@johpaz/hivecode-core/agent/agent-loop")
    model = startFakeModel((_turn, req) => {
      if (!req.tools) return { content: "Resumen: avancé a medias, falta cerrar el plan." }
      return { content: "", toolCalls: [{ name: "report_progress", args: { message: `paso ${Math.random()}` } }] }
    })
    await seedFixture({ baseUrl: model.baseUrl })

    const output = await runAgentIsolated({
      agentId: AGENT_ID,
      taskDescription: "trabaja sin parar",
      threadId: "thread-partial",
      maxSteps: 2,
    })

    expect(output).toContain("avancé a medias")

    const runs = await (await col<any>("agentRuns")).scan()
    expect(runs[0]!.doc.status).toBe("needs_budget")
    expect(runs[0]!.doc.blocker).toBe("max_steps:2")
  })
})
