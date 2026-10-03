/**
 * E2E fixtures shared by the full-process, subagent, TUI rendering and
 * TUI configuration test suites.
 *
 * The only substituted component is the model provider: a local Bun.serve
 * instance speaking the OpenAI `/chat/completions` contract, scripted per
 * test. That keeps the harness control flow deterministic and offline while
 * still exercising a real HTTP round-trip through the production provider
 * stack and real HiveDB writes.
 *
 * Run: bun test --tsconfig-override tests/tsconfig.json tests/e2e/
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { storeProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"

// ── Constants ──────────────────────────────────────────────────────────────────

/** Must match packages/core/src/storage/crypto.ts SERVICE. */
export const SECRET_SERVICE = "hive-code"

export const PROVIDER_ID = "hivecode-e2e-fake"
export const MODEL_ID = "hivecode-e2e-model"

/** Coordinator profile seeded by seedFixture(): the agent every e2e run starts from. */
export const AGENT_ID = "bee"

/** Native tools that survive the context-compiler minimal loadout filter. */
export const MINIMAL_TOOLS = ["save_note", "notify", "report_progress", "search_knowledge"]

export const previousDbPath = process.env.HIVE_DB_PATH

// ── Fake model server ──────────────────────────────────────────────────────────

export type ChatRequest = { messages: Array<Record<string, unknown>>; tools?: unknown[] }

export type ChatTurn = {
  content?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>
  usage?: { input: number; output: number }
  /** Override the reported finish_reason — llama.cpp/LM Studio say "stop" with tool calls. */
  finishReason?: string
}

/** Scripted OpenAI-compatible endpoint. `script` is called once per model turn. */
export function startFakeModel(script: (turn: number, req: ChatRequest) => ChatTurn) {
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

export type FakeModel = ReturnType<typeof startFakeModel>

// ── HiveDB fixture ─────────────────────────────────────────────────────────────

/**
 * Seed HiveDB with a provider, model and the core agent profiles so the
 * harness agent loop and ProfileHarness resolve a real configuration.
 */
export async function seedFixture(opts: {
  baseUrl: string
  maxIterations?: number
  maxInputTokens?: number
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  await (await col<any>("providers")).put(PROVIDER_ID, {
    id: PROVIDER_ID, user_id: "default", name: "E2E Fake Provider",
    enabled: true, active: true, base_url: opts.baseUrl, category: "llm",
    created_at: now, updated_at: now,
  })
  await (await col<any>("models")).put(MODEL_ID, {
    id: MODEL_ID, provider_id: PROVIDER_ID, name: MODEL_ID,
    context_window: 128_000, enabled: true, model_type: "llm",
    created_at: now, updated_at: now,
  })

  // Seed the five stable core agent profiles so ProfileHarness resolves them.
  const profiles: Array<{ id: string; name: string; type: string; prompt: string; tools: string[] }> = [
    {
      id: "bee", name: "BEE", type: "bee",
      prompt: "Eres BEE, el orquestador. Clasifica y delega.",
      tools: MINIMAL_TOOLS,
    },
    {
      id: "builder", name: "Builder", type: "builder",
      prompt: "Eres Builder. Implementa la tarea asignada.",
      tools: [...MINIMAL_TOOLS, "fs_write", "fs_read", "code_test"],
    },
    {
      id: "verifier", name: "Verifier", type: "verifier",
      prompt: "Eres Verifier. Reproduce los criterios de aceptación.",
      tools: [...MINIMAL_TOOLS, "code_test", "code_build"],
    },
    {
      id: "reviewer", name: "Reviewer", type: "reviewer",
      prompt: "Eres Reviewer. Emite el veredicto final.",
      tools: [...MINIMAL_TOOLS, "check_types", "code_test"],
    },
    {
      id: "scout", name: "Scout", type: "scout",
      prompt: "Eres Scout. Investiga sin modificar.",
      tools: MINIMAL_TOOLS,
    },
  ]

  for (const profile of profiles) {
    await (await col<any>("agents")).put(profile.id, {
      id: profile.id, user_id: "default", name: profile.name, description: null,
      system_prompt: profile.prompt, tone: null,
      role: profile.id === "bee" ? "coordinator" : "worker",
      agent_type: profile.type, status: "idle", enabled: true,
      provider_id: PROVIDER_ID, model_id: MODEL_ID,
      tools_json: JSON.stringify(profile.tools), skills_json: null, parent_id: "",
      max_iterations: opts.maxIterations ?? 20,
      permission_profile: profile.id === "bee" ? "orchestrate"
        : profile.id === "builder" ? "write_workspace"
        : profile.id === "verifier" ? "verify"
        : profile.id === "reviewer" ? "review"
        : "read_only",
      ...(opts.maxInputTokens ? { max_input_tokens: opts.maxInputTokens } : {}),
      workspace: null, created_at: now, updated_at: now,
    })
  }

  // Mark the fake provider as default so the coordinator-manager resolves it.
  await (await col<any>("codeConfig")).put("default_provider", {
    key: "default_provider", value: PROVIDER_ID,
    created_at: now, updated_at: now,
  })
  await (await col<any>("codeConfig")).put(`provider_model_${PROVIDER_ID}`, {
    key: `provider_model_${PROVIDER_ID}`, value: MODEL_ID,
    created_at: now, updated_at: now,
  })
}

// ── Test lifecycle ─────────────────────────────────────────────────────────────

/** Isolate HiveDB in a fresh temp directory before each test. */
export function isolateHiveDb(): string {
  closeHiveDb()
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-e2e-")), "hivedb")
  process.env.HIVE_DB_PATH = dbPath
  return dbPath
}

/** Store the fake API key in Bun.secrets so the provider stack resolves it. */
export async function seedApiKey(): Promise<void> {
  await Bun.secrets.set({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}`, value: "sk-e2e-fake" })
}

/** Clean up the fake API key from the OS keystore. */
export async function cleanupApiKey(): Promise<void> {
  try { await Bun.secrets.delete({ service: SECRET_SERVICE, name: `provider.${PROVIDER_ID}` }) } catch { /* already gone */ }
}

/** Restore the previous HIVE_DB_PATH and close HiveDB after all tests. */
export function restoreDbPath(): void {
  closeHiveDb()
  if (previousDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousDbPath
}
