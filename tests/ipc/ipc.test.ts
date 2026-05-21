import { describe, it, expect } from "bun:test"
import { messagePriority } from "@johpaz/hivecode-core/ipc/protocol"
import { wrap, serialize, unwrap } from "@johpaz/hivecode-core/ipc/envelope"
import type { BunMessage } from "@johpaz/hivecode-core/ipc/protocol"

// ─── messagePriority ─────────────────────────────────────────────────────────

describe("messagePriority", () => {
  it("init → critical", () => {
    const msg: BunMessage = {
      type: "init", mode: "plan", provider: "anthropic", model: "claude",
      project_name: "test", project_path: "/tmp", session_id: "s1",
      version: "0.1.0", task_count: 0, token_count: 0, workers: [],
    }
    expect(messagePriority(msg)).toBe("critical")
  })

  it("conflict_alert → critical", () => {
    const msg: BunMessage = {
      type: "conflict_alert", agent: "backend", file: "src/db.ts",
      reason: "concurrent write", severity: "high",
    }
    expect(messagePriority(msg)).toBe("critical")
  })

  it("file_risk_update → critical", () => {
    const msg: BunMessage = {
      type: "file_risk_update", path: "src/db.ts", risk: "critical",
      operation: "modified", adr_ref: null, reason: "schema file", agent: "backend",
    }
    expect(messagePriority(msg)).toBe("critical")
  })

  it("narrative_chunk → normal", () => {
    const msg: BunMessage = {
      type: "narrative_chunk", coordinator: "bee", phase: "thinking", content: "...",
    }
    expect(messagePriority(msg)).toBe("normal")
  })

  it("status → normal", () => {
    const msg: BunMessage = { type: "status", running: false, msg: "done" }
    expect(messagePriority(msg)).toBe("normal")
  })

  it("log_entry → low", () => {
    const msg: BunMessage = {
      type: "log_entry", timestamp: "2026-01-01T00:00:00Z",
      level: "info", source: "coordinator", message: "task started",
    }
    expect(messagePriority(msg)).toBe("low")
  })

  it("checkpoint_created → low", () => {
    const msg: BunMessage = {
      type: "checkpoint_created", checkpoint_id: "cp_1",
      description: "before write", file_count: 1, agent: "backend",
    }
    expect(messagePriority(msg)).toBe("low")
  })

  it("context_update → low", () => {
    const msg: BunMessage = {
      type: "context_update", agent: "backend", key: "db_schema", scope: "session",
    }
    expect(messagePriority(msg)).toBe("low")
  })
})

// ─── envelope wrap/unwrap ─────────────────────────────────────────────────────

describe("envelope wrap/serialize/unwrap", () => {
  it("wrap preserves type and payload", () => {
    const msg: BunMessage = { type: "status", running: true, msg: "thinking..." }
    const env = wrap("normal", msg as any)
    expect(env.priority).toBe("normal")
    expect(env.type).toBe("status")
    expect((env.payload as any).running).toBe(true)
    expect((env.payload as any).msg).toBe("thinking...")
  })

  it("seq increments between calls", () => {
    const a = wrap("low", { type: "log_entry", timestamp: "", level: "", source: "", message: "" } as any)
    const b = wrap("low", { type: "log_entry", timestamp: "", level: "", source: "", message: "" } as any)
    expect(b.seq).toBeGreaterThan(a.seq)
  })

  it("serialize produces valid NDJSON line", () => {
    const msg: BunMessage = { type: "status", running: false, msg: "done" }
    const line = serialize(wrap("normal", msg as any))
    expect(line.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(line.trim())
    expect(parsed.type).toBe("status")
    expect(parsed.priority).toBe("normal")
    expect(parsed.payload.msg).toBe("done")
  })

  it("unwrap reconstructs flat message", () => {
    const msg: BunMessage = { type: "status", running: false, msg: "ok" }
    const env = wrap("critical", msg as any)
    const flat = unwrap(env)
    expect(flat.type).toBe("status")
    expect((flat as any).running).toBe(false)
    expect((flat as any).msg).toBe("ok")
  })

  it("roundtrip: wrap → serialize → JSON.parse → unwrap", () => {
    const msg: BunMessage = { type: "activity_update", coordinator: "bee", phase: "planning", status: "running" }
    const line = serialize(wrap("normal", msg as any))
    const env = JSON.parse(line.trim())
    const flat = unwrap(env)
    expect(flat.type).toBe("activity_update")
    expect((flat as any).coordinator).toBe("bee")
  })
})
