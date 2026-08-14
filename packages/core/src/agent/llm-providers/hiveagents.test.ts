import { afterEach, describe, expect, test } from "bun:test";
import {
  HIVEAGENTS_BASE_URL,
  HIVEAGENTS_DEFAULT_LOAD_CTX,
  HIVEAGENTS_MODEL_ID,
  HIVEAGENTS_OPENAI_BASE_URL,
  HiveAgentsProvider,
  ensureHiveAgentsModelReady,
  loadHiveAgentsModel,
} from "./hiveagents";
import { SEED_DATA } from "../../storage/seed";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("HiveAgents fixed preset", () => {
  test("exposes only Qwen 3 Coder Next in the seeded catalog", () => {
    const models = SEED_DATA.models.filter((model) => model.providerId === "hiveagents");
    expect(models.map((model) => model.id)).toEqual([HIVEAGENTS_MODEL_ID]);
    expect(models[0]?.contextWindow).toBe(HIVEAGENTS_DEFAULT_LOAD_CTX);
  });

  test("loads the fixed model with the context supplied from the model catalog", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ success: true, loading: true }), { status: 202 });
    }) as typeof fetch;

    const result = await loadHiveAgentsModel("another-model", "secret", "https://other.invalid", 42000);

    expect(result.success).toBe(true);
    expect(request?.url).toBe(`${HIVEAGENTS_BASE_URL}/api/load`);
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      model: HIVEAGENTS_MODEL_ID,
      config: {
        ctx: 42000,
        kvType: "f16",
        flashAttn: false,
        jinja: true,
      },
    });
  });

  test("waits until status confirms the exact model is ready", async () => {
    let statusCalls = 0;
    let loadCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/load")) {
        loadCalls++;
        return new Response(JSON.stringify({ success: true, loading: true }), { status: 202 });
      }
      statusCalls++;
      const ready = statusCalls >= 3;
      return Response.json({
        loaded: ready,
        loading: !ready,
        error: null,
        model: ready ? { name: HIVEAGENTS_MODEL_ID } : null,
      });
    }) as typeof fetch;

    const result = await ensureHiveAgentsModelReady("secret", undefined, 0, 1000);

    expect(result.success).toBe(true);
    expect(result.loading).toBe(false);
    expect(result.status?.model?.name).toBe(HIVEAGENTS_MODEL_ID);
    expect(loadCalls).toBe(1);
    expect(statusCalls).toBe(3);
  });

  test("always infers with the exact loaded model and fixed endpoint", async () => {
    class InspectableProvider extends HiveAgentsProvider {
      baseUrl?: string;
      body?: Record<string, unknown>;

      protected async resolveOpenAIClient(_apiKey: string, baseUrl: string | undefined): Promise<any> {
        this.baseUrl = baseUrl;
        return {
          chat: {
            completions: {
              create: async (body: Record<string, unknown>) => {
                this.body = body;
                return {
                  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                };
              },
            },
          },
        };
      }
    }

    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      loaded: true,
      loading: false,
      error: null,
      model: { name: HIVEAGENTS_MODEL_ID },
    })) as typeof fetch;

    const provider = new InspectableProvider();
    const response = await provider.call({
      provider: "hiveagents",
      model: "wrong-model",
      apiKey: "secret",
      baseUrl: "https://wrong.invalid/v1",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.content).toBe("ok");
    expect(provider.baseUrl).toBe(HIVEAGENTS_OPENAI_BASE_URL);
    expect(provider.body?.model).toBe(HIVEAGENTS_MODEL_ID);
    // Top level, not nested under extra_body: that is a Python-SDK convention the JS
    // SDK forwards verbatim, so llama.cpp never saw the flag.
    expect(provider.body?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(provider.body?.extra_body).toBeUndefined();
    expect(provider.body?.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});
