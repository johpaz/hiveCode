import { describe, it, expect } from "bun:test"
import { parseBeeDecision, normalizeBeeDecision, formatBeeNarrative, parseGitDiffStat, formatToolResult } from "@johpaz/hivecode-code/coordinator/utils"

// ─── parseBeeDecision ─────────────────────────────────────────────────────────

describe("parseBeeDecision", () => {
  it("parsea JSON en bloque markdown", () => {
    const raw = '```json\n{"action":"dispatch","reason":"needs backend","phases":[]}\n```'
    const d = parseBeeDecision(raw)
    expect(d.action).toBe("dispatch")
    expect(d.reason).toBe("needs backend")
  })

  it("parsea JSON inline sin bloque", () => {
    const raw = 'Some text {"action":"respond","content":"hello","reason":""} more text'
    const d = parseBeeDecision(raw)
    expect(d.action).toBe("respond")
    expect(d.content).toBe("hello")
  })

  it("parsea JSON directo", () => {
    const raw = JSON.stringify({ action: "fix", content: "applied", reason: "trivial", filesModified: ["a.ts"] })
    const d = parseBeeDecision(raw)
    expect(d.action).toBe("fix")
    expect(d.filesModified).toEqual(["a.ts"])
  })

  it("respuesta vacía → respond con empty content", () => {
    const d = parseBeeDecision("")
    expect(d.action).toBe("respond")
  })

  it("texto plano → respond con el texto", () => {
    const d = parseBeeDecision("Lo siento, no puedo hacer eso.")
    expect(d.action).toBe("respond")
    expect(d.content).toBe("Lo siento, no puedo hacer eso.")
  })

  it("JSON roto en bloque markdown → fallback a respond", () => {
    const raw = '```json\n{"action":"architecture","reason":"needs design",}\n```'
    const d = parseBeeDecision(raw)
    expect(d.action).toBe("architecture")
  })
})

// ─── formatBeeNarrative ───────────────────────────────────────────────────────

describe("formatBeeNarrative", () => {
  it("respond → devuelve content", () => {
    const decision = normalizeBeeDecision({ action: "respond", content: "Aquí está la respuesta.", reason: "" })
    expect(formatBeeNarrative(decision)).toBe("Aquí está la respuesta.")
  })

  it("dispatch → lista coordinadores", () => {
    const decision = normalizeBeeDecision({
      action: "dispatch",
      reason: "needs work",
      phases: [{ coordinator: "backend", description: "API" }, { coordinator: "test", description: "Tests" }],
    })
    const out = formatBeeNarrative(decision)
    expect(out).toContain("backend")
    expect(out).toContain("test")
  })

  it("architecture → menciona diseño arquitectónico", () => {
    const decision = normalizeBeeDecision({ action: "architecture", reason: "new system" })
    const out = formatBeeNarrative(decision)
    expect(out).toContain("diseño arquitectónico")
  })
})

// ─── parseGitDiffStat ─────────────────────────────────────────────────────────

describe("parseGitDiffStat", () => {
  it("parsea líneas de git diff --stat", () => {
    const stat = `
 src/foo.ts    | 10 +++---
 src/bar/baz.ts |  3 +++
`
    const result = parseGitDiffStat(stat)
    expect(result["src/foo.ts"]).toEqual({ added: 3, removed: 3 })
    expect(result["src/bar/baz.ts"]).toEqual({ added: 3, removed: 0 })
  })

  it("ignora líneas sin formato válido", () => {
    const stat = "no files changed"
    const result = parseGitDiffStat(stat)
    expect(Object.keys(result)).toHaveLength(0)
  })
})

// ─── formatToolResult ─────────────────────────────────────────────────────────

describe("formatToolResult", () => {
  it("formatea error con ❌", () => {
    const out = formatToolResult("fs_write", { ok: false, error: "Permission denied" })
    expect(out).toContain("❌")
    expect(out).toContain("Permission denied")
  })

  it("formatea fs_read con path y líneas", () => {
    const out = formatToolResult("fs_read", { path: "foo.ts", linesRead: 10, totalLines: 10, content: "hello" })
    expect(out).toContain("foo.ts")
    expect(out).toContain("10/10")
  })

  it("formatea shell_executor con exit code", () => {
    const out = formatToolResult("shell_executor", { command: "bun test", exitCode: 0, executionTimeMs: 100, stdout: "passed" })
    expect(out).toContain("exit=0")
    expect(out).toContain("passed")
  })

  it("wraps en <system>", () => {
    const out = formatToolResult("fs_exists", { path: "foo.ts", exists: true })
    expect(out).toMatch(/^<system>/)
    expect(out).toMatch(/<\/system>$/)
  })
})
