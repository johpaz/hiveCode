import { expect, test } from "bun:test"
import { ALL_COMMANDS } from "../../../code/src/coordinator/command-parser"
import { startSession, frameText, waitForFrame } from "./harness"

for (const [downs, command] of [[2, "/session resume"], [3, "/session new"]] as const) {
  test(`slash navigation submits ${command} from ENJAMBRE`, async () => {
    const session = await startSession("approval", { cols: 130, rows: 40 })
    try {
      session.type("/layout enjambre\r")
      await waitForFrame(session.iter, f => f.tab === "enjambre", 5000, "vista ENJAMBRE")
      session.type("/se")
      const popup = await waitForFrame(session.iter, f => frameText(f).includes("/session resume") && frameText(f).includes("comandos"), 5000, "menú / en ENJAMBRE")
      expect(popup.tab).toBe("enjambre")
      session.type("\x1b[B".repeat(downs))
      const selected = await waitForFrame(session.iter, f => frameText(f).includes(`▸ ${command}`), 5000, "comando seleccionado")
      expect(frameText(selected)).toContain(`▸ ${command}`)
      session.type("\r")
      expect((await session.ipc.waitForMessage("submit")).input).toBe(command)
    } finally { session.dispose() }
  })
}

test("backend menu supplies all actions and Tab/Enter executes the chosen action", async () => {
  const session = await startSession("approval", { cols: 130, rows: 40 })
  try {
    session.ipc.send({ type: "quick_menu", items: ALL_COMMANDS.map(c => ({ label: c.command, cmd: c.command, desc: c.description })) })
    session.type("/narrative")
    await waitForFrame(session.iter, f => frameText(f).includes("/narrative show") && frameText(f).includes("/narrative export"), 5000, "comandos del backend")
    session.type("\x1b[B\t")
    await waitForFrame(session.iter, f => frameText(f).includes("▸ /narrative search"), 5000, "Tab completa la opción")
    session.type("\r")
    expect((await session.ipc.waitForMessage("submit")).input).toBe("/narrative search")
  } finally { session.dispose() }
})
