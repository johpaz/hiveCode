import { describe, it, expect } from "bun:test"
import { messagePriority } from "@johpaz/hivecode-core/ipc/protocol"
import { wrap, serialize, unwrap } from "@johpaz/hivecode-core/ipc/envelope"
import {
  summarizeArgs,
  toolToBeeState,
  emitToolCall,
  emitToolDone,
  emitWaiting,
} from "@johpaz/hivecode-core/agent/tool-telemetry"
import { eventBus } from "@johpaz/hivecode-core/events/event-bus"
import type { BunMessage } from "@johpaz/hivecode-core/ipc/protocol"

// ─── La telemetría del enjambre llega a la TUI ────────────────────────────────
//
// Antes de esto, el enjambre llamaba a sus herramientas a ciegas: la TUI recibía
// `current_action: "ejecutando <phase>"`, que no dice qué herramienta corre ni
// cuánto tarda. Estos tests fijan el contrato de los tres eventos nuevos.

// ─── summarizeArgs ────────────────────────────────────────────────────────────

describe("summarizeArgs", () => {
  it("colapses whitespace so a summary is always one line", () => {
    // La TUI asigna una línea por entrada: un salto de línea desalinea la tabla.
    expect(summarizeArgs('{\n  "path": "src/a.ts",\n  "n": 1\n}')).toBe('{ "path": "src/a.ts", "n": 1 }')
  })

  it("truncates to something a 30-cell column can hold", () => {
    // Un fs_read de 400 KB no se renderiza: se recorta.
    const big = { data: "x".repeat(50_000) }
    const summary = summarizeArgs(big)
    expect(summary.length).toBeLessThanOrEqual(120)
    expect(summary.endsWith("…")).toBe(true)
  })

  it("survives values JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(summarizeArgs(cyclic)).toBe("[no serializable]")
    expect(summarizeArgs(undefined)).toBe("")
    expect(summarizeArgs(null)).toBe("")
  })

  it("accepts a raw JSON string as well as an object", () => {
    expect(summarizeArgs('{"path":"a.ts"}')).toBe('{"path":"a.ts"}')
  })
})

// ─── toolToBeeState ───────────────────────────────────────────────────────────

describe("toolToBeeState", () => {
  it("groups tools into the activity the user recognises", () => {
    expect(toolToBeeState("fs_read")).toBe("reading")
    expect(toolToBeeState("parse_ast")).toBe("reading")
    expect(toolToBeeState("fs_write")).toBe("writing")
    expect(toolToBeeState("fs_edit")).toBe("writing")
    expect(toolToBeeState("shell_executor")).toBe("executing")
    expect(toolToBeeState("code_build")).toBe("executing")
    expect(toolToBeeState("search_knowledge")).toBe("searching")
    expect(toolToBeeState("browser_navigate")).toBe("searching")
  })

  it("falls back to thinking for an unknown tool", () => {
    // Nunca "error": una tool desconocida no es una tool rota.
    expect(toolToBeeState("tool_del_workspace_futuro")).toBe("thinking")
  })
})

// ─── Emisión ──────────────────────────────────────────────────────────────────

describe("swarm telemetry emits what the TUI needs", () => {
  it("a call and its completion share a call_id", async () => {
    const calls: unknown[] = []
    const dones: unknown[] = []
    const offCall = eventBus.on("tool:call", (e) => { calls.push(e) })
    const offDone = eventBus.on("tool:done", (e) => { dones.push(e) })

    try {
      emitToolCall({ agentId: "a1", tool: "fs_read", callId: "c7", argsSummary: "src/a.ts" })
      emitToolDone({ agentId: "a1", tool: "fs_read", callId: "c7", ok: true, durationMs: 412 })
      await Bun.sleep(0)
    } finally {
      offCall()
      offDone()
    }

    expect(calls).toHaveLength(1)
    expect(dones).toHaveLength(1)
    // El emparejamiento por call_id es lo que permite distinguir "empezó y no
    // terminó" de "terminó de verdad".
    expect((calls[0] as { callId: string }).callId).toBe((dones[0] as { callId: string }).callId)
  })

  it("a negative duration cannot leak into the UI", () => {
    let seen: number | undefined
    const off = eventBus.on("tool:done", (e) => { seen = e.durationMs })
    try {
      emitToolDone({ agentId: "a1", tool: "fs_read", ok: true, durationMs: -50 })
    } finally {
      off()
    }
    expect(seen).toBe(0)
  })

  it("a broken subscriber cannot break the tool call it observes", () => {
    // La telemetría nunca puede ser un cuello de botella para el trabajo real.
    let ran = false
    const off = eventBus.on("tool:call", () => { throw new Error("subscriber roto") })
    try {
      emitToolCall({ agentId: "a1", tool: "fs_read" })
      ran = true
    } finally {
      off()
    }
    expect(ran).toBe(true)
  })

  it("waiting names a cause, not a sentence", () => {
    let seen: { reason: string; waitingFor: string[] } | undefined
    const off = eventBus.on("agent:waiting", (e) => { seen = e })
    try {
      emitWaiting({ agentId: "a1", reason: "jev_secuencial", waitingFor: ["a2", "a3"] })
    } finally {
      off()
    }
    expect(seen?.reason).toBe("jev_secuencial")
    expect(seen?.waitingFor).toEqual(["a2", "a3"])
  })

  it("the waiting list is bounded", () => {
    // Un enjambre grande no puede producir un payload ilimitado.
    let seen: string[] = []
    const off = eventBus.on("agent:waiting", (e) => { seen = e.waitingFor })
    try {
      emitWaiting({ agentId: "a1", reason: "dependencia", waitingFor: Array.from({ length: 50 }, (_, i) => `a${i}`) })
    } finally {
      off()
    }
    expect(seen.length).toBeLessThanOrEqual(8)
  })
})

// ─── Contrato de cable ────────────────────────────────────────────────────────

describe("swarm telemetry on the wire", () => {
  const call: BunMessage = {
    type: "tool_call", agent: "a1", tool: "fs_write", call_id: "c1",
    args_summary: '{ "path": "src/a.ts" }', bee_state: "writing", at: 1_700_000_000_000,
  }
  const done: BunMessage = {
    type: "tool_done", agent: "a1", tool: "fs_write", call_id: "c1",
    ok: true, duration_ms: 412, result_summary: "ok", at: 1_700_000_000_412,
  }

  it("rides on normal, never on low", () => {
    // Si se perdieran en el embudo lento, la UI mostraría un spinner eterno.
    // El recorte por columna lo hace el consumidor.
    expect(messagePriority(call)).toBe("normal")
    expect(messagePriority(done)).toBe("normal")
  })

  it("survives the envelope round-trip with its pairing intact", () => {
    for (const original of [call, done]) {
      const back = unwrap(JSON.parse(serialize(wrap(messagePriority(original), original)))) as BunMessage
      expect(back).toEqual(original)
      expect((back as { call_id: string }).call_id).toBe("c1")
    }
  })

  it("the wire field names match what the Rust enum declares", () => {
    // Espejo de BunMessage::ToolCall / ToolDone / Esperando en ipc/mod.rs.
    // Si se renombra un campo en un lado, esta lista y serde dejan de coincidir
    // y serde lo ignora en silencio, dejando el campo en 0.
    expect(Object.keys(call).sort()).toEqual([
      "agent", "args_summary", "at", "bee_state", "call_id", "tool", "type",
    ])
    expect(Object.keys(done).sort()).toEqual([
      "agent", "at", "call_id", "duration_ms", "ok", "result_summary", "tool", "type",
    ])
  })

  it("a wait survives with its cause and its targets", () => {
    const w: BunMessage = {
      type: "esperando", agent: "topo", esperando_a: ["condor"], razon: "dependencia", at: 1,
    }
    const back = unwrap(JSON.parse(serialize(wrap(messagePriority(w), w)))) as BunMessage
    expect(back).toEqual(w)
    if (back.type !== "esperando") throw new Error("tipo incorrecto")
    expect(back.razon).toBe("dependencia")
    expect(back.esperando_a).toEqual(["condor"])
  })

  it("an empty waiting list still parses", () => {
    // Un agente puede esperar sin saber a quién: "en secuencia" no depende de nadie.
    const w: BunMessage = { type: "esperando", agent: "topo", esperando_a: [], razon: "jev_secuencial", at: 1 }
    const back = unwrap(JSON.parse(serialize(wrap(messagePriority(w), w)))) as BunMessage
    if (back.type !== "esperando") throw new Error("tipo incorrecto")
    expect(back.esperando_a).toEqual([])
  })
})