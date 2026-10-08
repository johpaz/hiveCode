import { describe, expect, test } from "bun:test"
import { sessionHistoryPreamble } from "./profile-harness"

describe("sessionHistoryPreamble", () => {
  test("is empty when there is no history", () => {
    expect(sessionHistoryPreamble(undefined)).toBe("")
    expect(sessionHistoryPreamble([])).toBe("")
  })

  test("lists earlier turns oldest first and ends where the new message goes", () => {
    const block = sessionHistoryPreamble([
      { role: "user", content: "hola" },
      { role: "agent", content: "¡Hola! Soy BEE" },
    ])
    expect(block.indexOf("Usuario: hola")).toBeLessThan(block.indexOf("Tú: ¡Hola! Soy BEE"))
    expect(block.endsWith("Mensaje actual del usuario:\n")).toBe(true)
  })

  test("keeps the newest turns when over budget and clips long ones", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `turno-${i} ${"x".repeat(1_400)}` }))
    const block = sessionHistoryPreamble(history)
    expect(block).toContain("turno-39")
    expect(block).not.toContain("turno-0 ")
    expect(block.length).toBeLessThan(13_500)
    expect(sessionHistoryPreamble([{ role: "agent", content: "y".repeat(5_000) }])).toContain("…")
  })
})
