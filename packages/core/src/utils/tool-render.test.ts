import { describe, expect, test } from "bun:test"
import { renderToolResult } from "./tool-render"
import { formatToolResult, renderText } from "./llm-text"

const root = "/work/app"

describe("renderToolResult", () => {
  test("fs_read: real line breaks and quotes, the path relative to the workspace", () => {
    const text = renderToolResult("fs_read", {
      ok: true, path: "/work/app/src/a.ts", content: '1: import x from "y"\n2: const a = "b"', totalLines: 40, linesRead: 2,
    }, { root })!
    expect(text).toBe('src/a.ts (2 de 40 líneas)\n1: import x from "y"\n2: const a = "b"')
    expect(text).not.toContain('\\"')
    expect(text).not.toContain("\\n")
  })

  test("fs_read keeps the note that says how to continue", () => {
    const text = renderToolResult("fs_read", { ok: true, path: "/work/app/a.ts", content: "1: x", totalLines: 900, linesRead: 120, note: "Continúa con fs_read offset=121" }, { root })!
    expect(text).toContain("[Continúa con fs_read offset=121]")
  })

  test("search_in_files: each file once, with its matches under it", () => {
    const text = renderToolResult("search_in_files", {
      ok: true, pattern: "route", count: 3, truncated: false,
      matches: [
        { file: "/work/app/src/a.ts", line: 3, content: "route()" },
        { file: "/work/app/src/a.ts", line: 9, content: "routeBudget" },
        { file: "/work/app/src/b.ts", line: 1, content: "// route" },
      ],
    }, { root })!
    expect(text).toBe('3 coincidencia(s) de "route"\nsrc/a.ts\n  3: route()\n  9: routeBudget\nsrc/b.ts\n  1: // route')
    expect(text.split("/work/app").length).toBe(1)
  })

  test("search_in_files says when the result was cut", () => {
    expect(renderToolResult("search_in_files", { ok: true, pattern: "x", count: 1, truncated: true, matches: [{ file: "a.ts", line: 1, content: "x" }] })).toContain("truncado")
  })

  test("outline, find_symbol, dependents and tests_for are one line per fact", () => {
    expect(renderToolResult("outline", { ok: true, path: "src/a.ts", stale: true, symbols: [{ lines: "1-9", kind: "function", signature: "export function a()", exported: true }], imports: ["src/b.ts"] }))
      .toBe("src/a.ts [el archivo cambió desde que se indexó: confírmalo en disco]\n1-9 function export function a() (export)\nimporta: src/b.ts")
    expect(renderToolResult("find_symbol", { ok: true, name: "a", total: 1, matches: [{ path: "src/a.ts", lines: "1-9", kind: "function", name: "a", signature: "function a()" }] }))
      .toBe('1 coincidencia(s) de "a"\nsrc/a.ts:1-9 function function a()')
    expect(renderToolResult("dependents", { ok: true, path: "src/a.ts", imported_by: ["src/b.ts"], imported_by_total: 1, imports: [], imports_total: 0 }))
      .toBe("src/a.ts\nlo importan (1): src/b.ts\nimporta (0): nada")
    expect(renderToolResult("tests_for", { ok: true, path: "src/a.ts", kind: "source", tests: ["src/a.test.ts"] })).toBe("src/a.ts\npruebas: src/a.test.ts")
  })

  test("errors, unknown tools and unexpected shapes are left to the generic renderer", () => {
    expect(renderToolResult("fs_read", { ok: false, error: "no such file" })).toBeUndefined()
    expect(renderToolResult("shell_executor", { ok: true, stdout: "x" })).toBeUndefined()
    expect(renderToolResult("outline", "not an object")).toBeUndefined()
    expect(renderToolResult("search_in_files", { ok: true, files: [{ file: "a", count: 1 }] })).toBeUndefined()
  })
})

describe("formatToolResult", () => {
  test("renders text for the tools that have a renderer and the generic text for the rest", () => {
    expect(formatToolResult({ ok: true, path: "a.ts", content: "1: x", totalLines: 1, linesRead: 1 }, { name: "fs_read" })).toBe("a.ts (1 de 1 líneas)\n1: x")
    expect(formatToolResult({ ok: true, path: "a.ts", content: "1: x" })).toBe("ok: true\npath: a.ts\ncontent: 1: x")
    expect(formatToolResult({ ok: false, error: "boom" }, { name: "fs_read" })).toBe("ok: false\nerror: boom")
  })

  test("a string goes as it is", () => {
    expect(formatToolResult("ya es texto")).toBe("ya es texto")
  })
})

describe("renderText", () => {
  test("flat records are one line per key, with no quoting", () => {
    expect(renderText({ ok: true, count: 3, name: 'a "quoted" word', skipped: undefined, nothing: null })).toBe('ok: true\ncount: 3\nname: a "quoted" word\nnothing: null')
  })

  test("multi-line values keep their line breaks, indented under the key", () => {
    expect(renderText({ exit_code: 1, stdout: "línea 1\nlínea 2", stderr: "" })).toBe("exit_code: 1\nstdout:\n  línea 1\n  línea 2\nstderr: ")
  })

  test("lists: scalars on one line, objects as items", () => {
    expect(renderText({ tags: ["a", "b", 3], none: [] })).toBe("tags: a, b, 3\nnone: (vacío)")
    expect(renderText({ items: [{ id: 1, name: "x" }, { id: 2, name: "y" }] })).toBe("items:\n  - id: 1\n    name: x\n  - id: 2\n    name: y")
  })

  test("a circular reference and a very deep value do not hang or throw", () => {
    const loop: any = { name: "a" }
    loop.self = loop
    expect(renderText(loop)).toContain("[circular]")
    let deep: any = "end"
    for (let i = 0; i < 10; i++) deep = { next: deep }
    expect(renderText(deep)).toContain("[…]")
  })

  test("an Error is its message, and a Date its ISO form", () => {
    expect(renderText({ err: new Error("boom"), at: new Date("2026-10-22T00:00:00Z") })).toBe("err: boom\nat: 2026-10-22T00:00:00.000Z")
  })
})
