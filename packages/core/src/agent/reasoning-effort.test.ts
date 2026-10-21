import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chooseReasoningEffort, modelReasons, resolveReasoningPolicy } from "./reasoning-effort"
import { CORE_AGENT_DEFINITIONS } from "./agent-profiles"
import { OpenCodeGoProvider } from "./llm-providers/opencode-go"
import { DeepSeekProvider } from "./llm-providers/deepseek"
import type { LLMCallOptions } from "./llm-client"

const REASONING = JSON.stringify(["chat", "code", "function_calling", "streaming", "reasoning"])
const PLAIN = JSON.stringify(["chat", "code"])

describe("resolveReasoningPolicy", () => {
  const run = { base: "low", onFailure: "medium" } as const
  const profile = { base: "high", onFailure: "high" } as const

  test("the harness decision beats the profile, and the profile beats the TUI effort", () => {
    expect(resolveReasoningPolicy({ run, profile, agentEffort: "max", capabilitiesJson: REASONING, env: {} })).toEqual(run)
    expect(resolveReasoningPolicy({ profile, agentEffort: "low", capabilitiesJson: REASONING, env: {} })).toEqual(profile)
  })

  test("the agent effort set in the TUI is only the last resort", () => {
    expect(resolveReasoningPolicy({ agentEffort: "low", capabilitiesJson: REASONING, env: {} })).toEqual({ base: "low", onFailure: "low" })
    expect(resolveReasoningPolicy({ agentEffort: "max", capabilitiesJson: REASONING, env: {} })).toEqual({ base: "high", onFailure: "high" })
    expect(resolveReasoningPolicy({ capabilitiesJson: REASONING, env: {} })).toBeUndefined()
  })

  test("sends nothing for a model that does not reason: an unknown field can be rejected", () => {
    expect(resolveReasoningPolicy({ run, capabilitiesJson: PLAIN, env: {} })).toBeUndefined()
    expect(resolveReasoningPolicy({ run, capabilitiesJson: null, env: {} })).toBeUndefined()
    expect(resolveReasoningPolicy({ run, capabilitiesJson: "not json", env: {} })).toBeUndefined()
  })

  test("HIVECODE_REASONING_EFFORT overrides everything, and off restores the old behaviour", () => {
    const fixedHigh = { base: "high", onFailure: "high" } as const
    expect(resolveReasoningPolicy({ run, profile, capabilitiesJson: REASONING, env: { HIVECODE_REASONING_EFFORT: " HIGH " } })).toEqual(fixedHigh)
    expect(resolveReasoningPolicy({ run, capabilitiesJson: REASONING, env: { HIVECODE_REASONING_EFFORT: "off" } })).toBeUndefined()
    expect(resolveReasoningPolicy({ run, capabilitiesJson: REASONING, env: { HIVECODE_REASONING_EFFORT: "nonsense" } })).toEqual(run)
    // The override never forces the field onto a model that does not reason.
    expect(resolveReasoningPolicy({ run, capabilitiesJson: PLAIN, env: { HIVECODE_REASONING_EFFORT: "low" } })).toBeUndefined()
  })

  test("modelReasons reads the catalog capability", () => {
    expect(modelReasons(REASONING)).toBe(true)
    expect(modelReasons(PLAIN)).toBe(false)
  })
})

describe("chooseReasoningEffort", () => {
  const policy = { base: "low", onFailure: "medium" } as const
  test("thinks harder only on the turn after a failure", () => {
    expect(chooseReasoningEffort(policy, false)).toBe("low")
    expect(chooseReasoningEffort(policy, true)).toBe("medium")
    expect(chooseReasoningEffort(undefined, true)).toBeUndefined()
  })
})

describe("core profile policies", () => {
  test("every profile declares one, and the planner thinks the hardest", () => {
    for (const definition of Object.values(CORE_AGENT_DEFINITIONS)) expect(definition.reasoning).toBeDefined()
    expect(CORE_AGENT_DEFINITIONS.planner.reasoning).toEqual({ base: "high", onFailure: "high" })
    expect(CORE_AGENT_DEFINITIONS.builder.reasoning.base).toBe("low")
  })
})

describe("reasoning_effort on the wire", () => {
  const bodies: any[] = []
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push(await req.json())
        return Response.json({
          id: "x", object: "chat.completion", created: 0, model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
  })
  afterAll(() => server.stop(true))

  const call = async (provider: OpenCodeGoProvider | DeepSeekProvider, name: string, extra: Partial<LLMCallOptions> = {}) => {
    await provider.call({
      provider: name, model: "m", apiKey: "k", baseUrl: `http://localhost:${server.port}/v1`,
      messages: [{ role: "user", content: "hola" }], ...extra,
    } as LLMCallOptions)
    return bodies.at(-1)
  }

  test("OpenCode Go sends it when asked", async () => {
    expect((await call(new OpenCodeGoProvider(), "opencode-go", { reasoningEffort: "low" })).reasoning_effort).toBe("low")
  })

  test("nothing is sent when no level is asked for", async () => {
    expect((await call(new OpenCodeGoProvider(), "opencode-go")).reasoning_effort).toBeUndefined()
  })

  test("an explicit extraBody value wins", async () => {
    const body = await call(new OpenCodeGoProvider(), "opencode-go", { reasoningEffort: "low", extraBody: { reasoning_effort: "high" } })
    expect(body.reasoning_effort).toBe("high")
  })

  test("a provider whose profile does not accept it never gets the field", async () => {
    expect((await call(new DeepSeekProvider(), "deepseek", { reasoningEffort: "low" })).reasoning_effort).toBeUndefined()
  })
})
