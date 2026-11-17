/**
 * Modo de una acción por contexto (experimental, apagado por defecto), de extremo a extremo.
 *
 * Un worker aislado hace una llamada a una herramienta, el estado de la tarea se destila (una llamada más al
 * modelo, con el prompt del traspaso) y la conversación se reinicia con SOLO la tarea y ese estado. El modelo
 * es un servidor local con el contrato de OpenAI; la clave es de un proveedor inventado y se borra al final.
 *
 * Run: bun test tests/agent-loop/single-action.test.ts
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { runAgentIsolated } from "@johpaz/hivecode-core/agent/agent-loop"
import { resetConfig } from "../../packages/core/src/config/loader"

type ChatRequest = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }

const SECRET_SERVICE = "hive-code" // must match packages/core/src/storage/crypto.ts
const PROVIDER_ID = "hivecode-sac-fake"
const MODEL_ID = "hivecode-sac-model"
const AGENT_ID = "sac-worker"
const TASK = "Guarda la nota alfa y luego la nota beta, y dime cuántas guardaste."
const STATE = { objective: TASK, facts: ["nota alfa guardada"], changes: ["save_note alfa"], verification: [], dead_ends: [], plan: ["guardar beta"] }

const requests: ChatRequest[] = []
let failState = false
let step = 0

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as ChatRequest
    requests.push(body)
    const isStateCall = String(body.messages[0]?.content).includes("conversation state compactor")
    const message: Record<string, unknown> = { role: "assistant", content: "" }
    let finish = "stop"
    if (isStateCall) {
      if (failState) return new Response("boom", { status: 500 })
      message.content = JSON.stringify(STATE)
    } else {
      step++
      if (step === 1) {
        message.tool_calls = [{ id: "c1", type: "function", function: { name: "save_note", arguments: JSON.stringify({ key: "alfa", value: "1" }) } }]
        finish = "tool_calls"
      } else if (step === 2) {
        message.tool_calls = [{ id: "c2", type: "function", function: { name: "save_note", arguments: JSON.stringify({ key: "beta", value: "2" }) } }]
        finish = "tool_calls"
      } else {
        message.content = "Guardé 2 notas."
      }
    }
    return Response.json({
      id: "c", object: "chat.completion", created: 1, model: MODEL_ID,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  },
})

const previousDbPath = process.env.HIVE_DB_PATH
const previousFlag = process.env.HIVECODE_SINGLE_ACTION

async function seed() {
  const now = Math.floor(Date.now() / 1000)
  await (await col<any>("providers")).put(PROVIDER_ID, {
    id: PROVIDER_ID, user_id: "default", name: "Fake", enabled: true, active: true,
    base_url: `http://127.0.0.1:${server.port}/v1`, created_at: now, updated_at: now,
  })
  await (await col<any>("models")).put(MODEL_ID, {
    id: MODEL_ID, provider_id: PROVIDER_ID, name: MODEL_ID, context_window: 128_000, enabled: true, created_at: now, updated_at: now,
  })
  await (await col<any>("agents")).put(AGENT_ID, {
    id: AGENT_ID, user_id: "default", name: "SAC", description: null, system_prompt: "Eres un worker de pruebas.", tone: null,
    role: "worker", agent_type: "bee", status: "idle", enabled: true,
    provider_id: PROVIDER_ID, model_id: MODEL_ID,
    tools_json: JSON.stringify(["save_note", "notify", "report_progress", "search_knowledge"]), skills_json: null, parent_id: "",
    max_iterations: 10, workspace: null, created_at: now, updated_at: now,
  })
}

function run(threadId: string) {
  return runAgentIsolated({ agentId: AGENT_ID, taskDescription: TASK, threadId })
}

const mainCalls = () => requests.filter((r) => !String(r.messages[0]?.content).includes("conversation state compactor"))
const stateCalls = () => requests.filter((r) => String(r.messages[0]?.content).includes("conversation state compactor"))

beforeEach(async () => {
  requests.length = 0
  step = 0
  failState = false
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-sac-")), "hivedb")
  await Bun.secrets.set({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}`, value: "sk-sac-fake" })
  await seed()
})

afterEach(async () => {
  await Bun.sleep(20)
  delete process.env.HIVECODE_SINGLE_ACTION
  resetConfig()
})

afterAll(async () => {
  server.stop(true)
  closeHiveDb()
  try { await Bun.secrets.delete({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}` }) } catch { /* already gone */ }
  if (previousDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousDbPath
  if (previousFlag === undefined) delete process.env.HIVECODE_SINGLE_ACTION
  else process.env.HIVECODE_SINGLE_ACTION = previousFlag
  resetConfig()
})

describe("modo de una acción por contexto", () => {
  test("apagado por defecto: el historial crece y no hay llamadas de estado", async () => {
    const output = await run("sac-off")
    expect(output).toContain("Guardé 2 notas")
    expect(stateCalls()).toHaveLength(0)
    const last = mainCalls().at(-1)!
    expect(last.messages.map((m) => m.role)).toContain("tool")
    expect(last.messages.length).toBeGreaterThan(4)
  })

  test("encendido: tras cada acción el contexto se reinicia con la tarea y el estado", async () => {
    process.env.HIVECODE_SINGLE_ACTION = "true"
    resetConfig()
    const output = await run("sac-on")
    expect(output).toContain("Guardé 2 notas")
    expect(stateCalls()).toHaveLength(2) // una por acción con herramientas

    const [first, second, third] = mainCalls()
    expect(first!.messages.length).toBe(2) // sistema + tarea
    // Segunda y tercera llamada: sistema + tarea + estado, sin el resultado de la herramienta.
    for (const call of [second!, third!]) {
      expect(call.messages.length).toBe(3)
      expect(call.messages.map((m) => m.role)).not.toContain("tool")
      expect(String(call.messages[2]!.content)).toContain("ESTADO ACTUAL DE LA TAREA")
      expect(String(call.messages[2]!.content)).toContain("nota alfa guardada")
    }
  })

  test("si no se puede actualizar el estado, el historial NO se recorta", async () => {
    process.env.HIVECODE_SINGLE_ACTION = "true"
    resetConfig()
    failState = true
    const output = await run("sac-fail")
    expect(output).toContain("Guardé 2 notas")
    const last = mainCalls().at(-1)!
    expect(last.messages.map((m) => m.role)).toContain("tool")
  })
})
