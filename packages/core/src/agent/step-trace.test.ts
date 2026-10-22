import { describe, expect, test } from "bun:test"
import { argsPreview } from "./step-trace"

describe("argsPreview", () => {
  test("a read says which file and which range", () => {
    expect(argsPreview("fs_read", { path: "src/a.ts" })).toBe("src/a.ts")
    expect(argsPreview("fs_read", '{"path":"src/a.ts","offset":120,"limit":40}')).toBe("src/a.ts [120+40]")
  })

  test("searches, symbols and listings say what they look for", () => {
    expect(argsPreview("search_in_files", { pattern: "route", path: "packages/core" })).toBe("route @ packages/core")
    expect(argsPreview("find_symbol", { name: "decideTier" })).toBe("decideTier")
    expect(argsPreview("search_knowledge", { type: "code", query: "harness" })).toBe("code: harness")
    expect(argsPreview("outline", { path: "src/a.ts" })).toBe("src/a.ts")
  })

  test("a delegation says who gets it, what it carries, and how its brief starts", () => {
    const text = argsPreview("task_delegate", { worker_id: "planner", ref: "P1", after: ["S1"], context: "x".repeat(500), task_description: "Escribe el   roadmap\npriorizado" })!
    expect(text.startsWith("planner P1 after=[\"S1\"] context=500c | Escribe el roadmap priorizado")).toBe(true)
  })

  test("a call with nothing worth saying, or arguments that do not parse, previews nothing", () => {
    expect(argsPreview("report_progress", { message: "x" })).toBeUndefined()
    expect(argsPreview("fs_read", "{not json")).toBeUndefined()
  })
})
