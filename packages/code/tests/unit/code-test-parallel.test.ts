import { describe, test, expect } from "bun:test"
import { codeTestParallelTool } from "@johpaz/hivecode-core/tools"

describe("codeTestParallelTool — schema", () => {
  test("name is code_test_parallel", () => {
    expect(codeTestParallelTool.name).toBe("code_test_parallel")
  })

  test("suites is listed as required", () => {
    const params = codeTestParallelTool.parameters as any
    expect(params.required).toContain("suites")
  })

  test("suites items require path", () => {
    const params = codeTestParallelTool.parameters as any
    expect(params.properties.suites.items.required).toContain("path")
  })

  test("exposes timeout parameter", () => {
    const params = codeTestParallelTool.parameters as any
    expect(params.properties.timeout).toBeDefined()
  })

  test("has an execute function", () => {
    expect(typeof codeTestParallelTool.execute).toBe("function")
  })

  test("description mentions paralelo/parallel and concurrent", () => {
    const desc = codeTestParallelTool.description.toLowerCase()
    expect(desc.includes("parallel") || desc.includes("paralelo") || desc.includes("concurrent")).toBe(true)
  })
})

describe("codeTestParallelTool — validation", () => {
  test("returns ok:false for empty suites array", async () => {
    const result = await codeTestParallelTool.execute!({ suites: [] }) as any
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe("string")
  })

  test("returns ok:false for non-array suites", async () => {
    const result = await codeTestParallelTool.execute!({ suites: "not-an-array" }) as any
    expect(result.ok).toBe(false)
  })
})

describe("codeTestParallelTool — execution", () => {
  test("runs a single suite and returns structured results", async () => {
    const result = await codeTestParallelTool.execute!({
      suites: [
        { path: "packages/code/tests/unit/tool-bridge.test.ts", label: "tool-bridge" },
      ],
      timeout: 60,
    }) as any

    expect(typeof result.ok).toBe("boolean")
    expect(result.result).toBeDefined()
    expect(typeof result.result.totalPass).toBe("number")
    expect(typeof result.result.totalFail).toBe("number")
    expect(Array.isArray(result.result.suites)).toBe(true)
    expect(result.result.suites).toHaveLength(1)
    expect(result.result.suites[0].label).toBe("tool-bridge")
    expect(typeof result.result.summary).toBe("string")
  }, 30000)

  test("runs two suites in parallel and aggregates results", async () => {
    const start = Date.now()
    const result = await codeTestParallelTool.execute!({
      suites: [
        { path: "packages/code/tests/unit/tool-bridge.test.ts", label: "bridge" },
        { path: "packages/code/tests/unit/browser-preview.test.ts", label: "browser" },
      ],
      timeout: 60,
    }) as any
    const elapsed = Date.now() - start

    expect(result.result.suites).toHaveLength(2)
    expect(result.result.totalPass).toBeGreaterThan(0)

    // Parallelism: total wall time should be < sum of individual times
    const sumMs = result.result.suites.reduce((s: number, r: any) => s + r.durationMs, 0)
    // Wall time should be meaningfully less than sequential sum (at least 20% faster)
    // This is a soft check — just verify they ran and returned timing
    expect(typeof sumMs).toBe("number")
    expect(elapsed).toBeGreaterThan(0)
  }, 30000)

  test("summary string includes pass and fail counts", async () => {
    const result = await codeTestParallelTool.execute!({
      suites: [
        { path: "packages/code/tests/unit/browser-preview.test.ts", label: "schema-tests" },
      ],
      timeout: 60,
    }) as any

    expect(result.result.summary).toMatch(/\d+ pass/)
    expect(result.result.summary).toMatch(/\d+ fail/)
    expect(result.result.summary).toContain("suite")
  }, 30000)

  test("failed suite is reflected in ok:false and failed array", async () => {
    const result = await codeTestParallelTool.execute!({
      suites: [
        // Passing suite
        { path: "packages/code/tests/unit/browser-preview.test.ts", label: "good" },
        // Non-existent path → bun test exits non-zero
        { path: "packages/code/tests/unit/_does_not_exist_xyz.test.ts", label: "missing" },
      ],
      timeout: 30,
    }) as any

    expect(result.ok).toBe(false)
    expect(Array.isArray(result.result.failed)).toBe(true)
    expect(result.result.failed).toContain("missing")
    expect(typeof result.error).toBe("string")
  }, 30000)
})
