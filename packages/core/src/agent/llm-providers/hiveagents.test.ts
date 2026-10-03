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

const QWEN_VISION_MODEL_ID = "Qwen3.8-27B-UD-Q4_K_XL.gguf";

describe("HiveAgents preset", () => {
  test("seeds the catalog with the default model and the 27B vision model", () => {
    const models = SEED_DATA.models.filter((model) => model.providerId === "hiveagents");
    expect(models.map((model) => model.id)).toEqual([HIVEAGENTS_MODEL_ID, QWEN_VISION_MODEL_ID]);
    // El context_window del registro es lo que se manda como ctx a /api/load.
    for (const model of models) {
      expect(model.contextWindow).toBe(HIVEAGENTS_DEFAULT_LOAD_CTX);
    }
    expect(models[1]?.capabilities).toContain("vision");
  });

  test("loads the requested model with the context supplied from the model catalog", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ success: true, loading: true }), { status: 202 });
    }) as typeof fetch;

    const result = await loadHiveAgentsModel(QWEN_VISION_MODEL_ID, "secret", "https://other.invalid", 42000);

    expect(result.success).toBe(true);
    expect(request?.url).toBe(`${HIVEAGENTS_BASE_URL}/api/load`);
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      model: QWEN_VISION_MODEL_ID,
      config: {
        ctx: 42000,
        kvType: "f16",
        flashAttn: false,
        jinja: true,
      },
    });
  });

  test("falls back to the default model when no model is supplied", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ success: true, loading: true }), { status: 202 });
    }) as typeof fetch;

    await loadHiveAgentsModel("", "secret");

    expect(JSON.parse(String(request?.init?.body)).model).toBe(HIVEAGENTS_MODEL_ID);
  });

  test("waits until status confirms the requested model is ready", async () => {
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
        model: ready ? { name: QWEN_VISION_MODEL_ID } : null,
      });
    }) as typeof fetch;

    const result = await ensureHiveAgentsModelReady(
      "secret", undefined, 0, 1000, HIVEAGENTS_DEFAULT_LOAD_CTX, QWEN_VISION_MODEL_ID,
    );

    expect(result.success).toBe(true);
    expect(result.loading).toBe(false);
    expect(result.status?.model?.name).toBe(QWEN_VISION_MODEL_ID);
    expect(loadCalls).toBe(1);
    expect(statusCalls).toBe(3);
  });

  test("does not accept a different model as ready", async () => {
    // El backend monta un modelo a la vez: si tiene cargado otro, hay que esperar
    // a que termine de montar el pedido, no dar por bueno el que ya estaba.
    let loadCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/load")) {
        loadCalls++;
        return new Response(JSON.stringify({ success: true }), { status: 202 });
      }
      return Response.json({
        loaded: true,
        loading: false,
        error: null,
        model: { name: HIVEAGENTS_MODEL_ID },
      });
    }) as typeof fetch;

    const result = await ensureHiveAgentsModelReady(
      "secret", undefined, 0, 50, HIVEAGENTS_DEFAULT_LOAD_CTX, QWEN_VISION_MODEL_ID,
    );

    expect(result.success).toBe(false);
    expect(loadCalls).toBe(1);
  });

  test("infers with the selected model on the fixed endpoint", async () => {
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
      model: { name: QWEN_VISION_MODEL_ID },
    })) as typeof fetch;

    const provider = new InspectableProvider();
    const response = await provider.call({
      provider: "hiveagents",
      model: QWEN_VISION_MODEL_ID,
      apiKey: "secret",
      baseUrl: "https://wrong.invalid/v1",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.content).toBe("ok");
    // El endpoint sí sigue siendo fijo; el modelo ya no.
    expect(provider.baseUrl).toBe(HIVEAGENTS_OPENAI_BASE_URL);
    expect(provider.body?.model).toBe(QWEN_VISION_MODEL_ID);
    // Top level, not nested under extra_body: that is a Python-SDK convention the JS
    // SDK forwards verbatim, so llama.cpp never saw the flag.
    expect(provider.body?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(provider.body?.extra_body).toBeUndefined();
    expect(provider.body?.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});
