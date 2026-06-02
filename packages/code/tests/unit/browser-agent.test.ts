/**
 * Unit tests for agent-browser tools.
 * Only schema/metadata and fallback behavior are verified here —
 * actual subprocess execution requires agent-browser CLI installed.
 */
import { describe, test, expect } from "bun:test"
import {
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserExtractTool,
  browserScriptTool,
  browserWaitTool,
} from "@johpaz/hivecode-core/tools"

// ── Schema tests ─────────────────────────────────────────────────────────────

describe("browserNavigateTool — schema", () => {
  test("name is browser_navigate", () => {
    expect(browserNavigateTool.name).toBe("browser_navigate")
  })

  test("url is required", () => {
    const params = browserNavigateTool.parameters as any
    expect(Array.isArray(params.required)).toBe(true)
    expect(params.required).toContain("url")
  })

  test("exposes waitFor, timeoutMs, newSession, useScreenshot", () => {
    const props = (browserNavigateTool.parameters as any).properties
    expect(props.url).toBeDefined()
    expect(props.waitFor).toBeDefined()
    expect(props.timeoutMs).toBeDefined()
    expect(props.newSession).toBeDefined()
    expect(props.useScreenshot).toBeDefined()
  })

  test("has an execute function", () => {
    expect(typeof browserNavigateTool.execute).toBe("function")
  })

  test("description mentions accessibility tree", () => {
    expect(browserNavigateTool.description.toLowerCase()).toContain("accessibility")
  })
})

describe("browserClickTool — schema", () => {
  test("name is browser_click", () => {
    expect(browserClickTool.name).toBe("browser_click")
  })

  test("selector is required", () => {
    const params = browserClickTool.parameters as any
    expect(params.required).toContain("selector")
  })

  test("exposes sessionId and timeoutMs", () => {
    const props = (browserClickTool.parameters as any).properties
    expect(props.selector).toBeDefined()
    expect(props.sessionId).toBeDefined()
    expect(props.timeoutMs).toBeDefined()
  })

  test("has an execute function", () => {
    expect(typeof browserClickTool.execute).toBe("function")
  })
})

describe("browserTypeTool — schema", () => {
  test("name is browser_type", () => {
    expect(browserTypeTool.name).toBe("browser_type")
  })

  test("selector and text are required", () => {
    const params = browserTypeTool.parameters as any
    expect(params.required).toContain("selector")
    expect(params.required).toContain("text")
  })

  test("exposes clear flag", () => {
    const props = (browserTypeTool.parameters as any).properties
    expect(props.clear).toBeDefined()
    expect(props.clear.type).toBe("boolean")
  })

  test("has an execute function", () => {
    expect(typeof browserTypeTool.execute).toBe("function")
  })
})

describe("browserExtractTool — schema", () => {
  test("name is browser_extract", () => {
    expect(browserExtractTool.name).toBe("browser_extract")
  })

  test("has no required params (selector is optional)", () => {
    const params = browserExtractTool.parameters as any
    expect(!params.required || params.required.length === 0).toBe(true)
  })

  test("format enum contains text, json, links", () => {
    const props = (browserExtractTool.parameters as any).properties
    expect(props.format).toBeDefined()
    expect(props.format.enum).toContain("text")
    expect(props.format.enum).toContain("json")
    expect(props.format.enum).toContain("links")
  })

  test("has an execute function", () => {
    expect(typeof browserExtractTool.execute).toBe("function")
  })
})

describe("browserScriptTool — schema", () => {
  test("name is browser_script", () => {
    expect(browserScriptTool.name).toBe("browser_script")
  })

  test("script is required", () => {
    const params = browserScriptTool.parameters as any
    expect(params.required).toContain("script")
  })

  test("exposes sessionId and timeoutMs", () => {
    const props = (browserScriptTool.parameters as any).properties
    expect(props.script).toBeDefined()
    expect(props.sessionId).toBeDefined()
    expect(props.timeoutMs).toBeDefined()
  })

  test("has an execute function", () => {
    expect(typeof browserScriptTool.execute).toBe("function")
  })
})

describe("browserWaitTool — schema", () => {
  test("name is browser_wait", () => {
    expect(browserWaitTool.name).toBe("browser_wait")
  })

  test("selector is required", () => {
    const params = browserWaitTool.parameters as any
    expect(params.required).toContain("selector")
  })

  test("exposes timeoutMs and sessionId", () => {
    const props = (browserWaitTool.parameters as any).properties
    expect(props.timeoutMs).toBeDefined()
    expect(props.sessionId).toBeDefined()
  })

  test("has an execute function", () => {
    expect(typeof browserWaitTool.execute).toBe("function")
  })
})

// ── Fallback behavior tests ───────────────────────────────────────────────────

describe("fallback behavior — no active session", () => {
  test("browser_click without session returns structured error", async () => {
    const result = await browserClickTool.execute({ selector: "#btn" }) as any
    // Either not installed or no active session — both produce ok: false
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe("string")
    expect(result.error.length).toBeGreaterThan(0)
  })

  test("browser_type without session returns structured error", async () => {
    const result = await browserTypeTool.execute({ selector: "#input", text: "hello" }) as any
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe("string")
  })

  test("browser_extract without session returns structured error", async () => {
    const result = await browserExtractTool.execute({}) as any
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe("string")
  })

  test("browser_script without session returns structured error", async () => {
    const result = await browserScriptTool.execute({ script: "document.title" }) as any
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe("string")
  })

  test("browser_wait without session returns structured error", async () => {
    const result = await browserWaitTool.execute({ selector: ".loaded" }) as any
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe("string")
  })
})

describe("browser_navigate — fallback shape", () => {
  test("execute returns an object with ok property (1s timeout)", async () => {
    // Pass a 1ms navigation timeout so the test resolves quickly regardless
    // of whether agent-browser + Chrome are available in CI.
    const result = await browserNavigateTool.execute({
      url: "https://example.com",
      timeoutMs: 1,
    }) as any
    expect(typeof result).toBe("object")
    expect("ok" in result).toBe(true)
  }, 3000) // 3s test deadline
})
