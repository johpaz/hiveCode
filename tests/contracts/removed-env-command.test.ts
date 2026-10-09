import { expect, test } from "bun:test"
import { ALL_COMMANDS, parseInternalCommand, renderHelp, renderSuggestions, type ContextState } from "../../packages/code/src/coordinator/command-parser"

test("removed /env cannot print environment values or appear in command discovery", async () => {
  const ctx: ContextState = { sessionId: "test", activeProvider: "", activeModel: "", activeMode: "approval", activeMcp: [], activeSkills: [], projectPath: "/tmp" }
  const result = await parseInternalCommand("/env", undefined, ctx)
  expect(result.output).toContain("comando desconocido: env")
  expect(result.output).not.toContain("HOME=")
  expect(result.output).not.toContain("PATH=")
  expect(ALL_COMMANDS.some(command => command.command === "/env")).toBe(false)
  expect(renderSuggestions("/env")).not.toContain("/env")
  expect(renderHelp("system")).not.toContain("/env")
})
