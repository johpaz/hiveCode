import { expect, test } from "bun:test"
import { frameContains, startSession, waitForFrame } from "./harness"

test("office recognizes the six profile names received at startup", async () => {
  const session = await startSession("auto", { cols: 160, rows: 40,
    workers: ["BEE", "Builder", "Planner", "Quality Gate", "Scout", "Spider"] })
  try {
    session.type("1")
    const frame = await waitForFrame(session.iter, f => f.tab === "enjambre" && frameContains(f, "@CANGREJO"))
    for (const name of ["@ABEJA REINA", "@CÓNDOR", "@PUMA", "@HALCÓN", "@ARAÑA"]) {
      expect(frameContains(frame, name)).toBe(true)
    }
    expect(frame.rows.filter(row => row.includes("CHECKPOINTS"))).toHaveLength(1)
    session.type("\x1b[1;3B")
    const inspector = await waitForFrame(session.iter, f => frameContains(f, "Tarea:"))
    expect(frameContains(inspector, "BEE")).toBe(true)
    session.type("\r")
    await waitForFrame(session.iter, f => f.tab === "codigo")
  } finally {
    session.dispose()
  }
})

test("office selects an agent, shows live tools and opens Código", async () => {
  const session = await startSession("auto", { cols: 160, rows: 40 })
  try {
    session.ipc.send({ type: "worker_update", worker: "backend", phase: "editando", status: "running", current_file: "src/office.ts" })
    session.ipc.send({ type: "tool_call", agent: "backend", tool: "fs_read", call_id: "office-read", args_summary: '{"path":"src/office.ts"}', bee_state: "reading", at: 1 })
    session.type("1")
    await waitForFrame(session.iter, f => f.tab === "enjambre" && frameContains(f, "OFICINA") && frameContains(f, "fs_read"))
    session.type("\x1b[1;3B") // Alt+Down
    const selected = await waitForFrame(session.iter, f => f.tab === "enjambre" && frameContains(f, "Tarea:"))
    expect(frameContains(selected, "src/office.ts")).toBe(true)
    session.type("\r")
    await waitForFrame(session.iter, f => f.tab === "codigo")
    expect(session.ipc.received.some(m => m.type === "submit")).toBe(false)
    session.type("1\x1b")
    await waitForFrame(session.iter, f => f.tab === "enjambre" && !frameContains(f, "Tarea:"))
  } finally {
    session.dispose()
  }
})

for (const size of [{ cols: 100, rows: 24 }, { cols: 80, rows: 24 }, { cols: 40, rows: 12 }]) {
  test(`office remains usable at ${size.cols}x${size.rows}`, async () => {
    const session = await startSession("auto", size)
    try {
      session.type("1")
      const frame = await waitForFrame(session.iter, f => f.tab === "enjambre" && frameContains(f, "@TOPO"))
      expect(frameContains(frame, "demasiado pequeña")).toBe(false)
      session.type("\x1b[1;3B")
      await waitForFrame(session.iter, f => f.tab === "enjambre" && frameContains(f, "Tarea:"))
    } finally {
      session.dispose()
    }
  })
}
