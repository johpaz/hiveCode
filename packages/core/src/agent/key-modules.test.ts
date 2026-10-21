import { describe, expect, test } from "bun:test"
import { keyModules } from "./project-context"

const graph = (file: string, importedBy: string[], exports: string[] = []) => ({
  file_path: `/ws/${file}`, exported_by: JSON.stringify(importedBy), exports: JSON.stringify(exports), functions: "[]", classes: "[]",
}) as any

describe("keyModules", () => {
  test("lists the most imported files first, with a few exports", () => {
    const out = keyModules([
      graph("src/leaf.ts", []),
      graph("src/core.ts", ["a", "b", "c"], ["run", "stop"]),
      graph("src/util.ts", ["a"], ["pad"]),
    ], "/ws")
    expect(out.split("\n")).toEqual([
      "- src/core.ts (3 importers) → run, stop",
      "- src/util.ts (1 importers) → pad",
    ])
  })

  test("caps the list and tolerates unreadable rows", () => {
    const rows = Array.from({ length: 30 }, (_, i) => graph(`src/f${i}.ts`, ["x"]))
    rows.push({ file_path: "/ws/bad.ts", exported_by: "{nope", exports: "{nope" } as any)
    expect(keyModules(rows, "/ws").split("\n").length).toBe(10)
  })

  test("is empty when nothing is imported", () => {
    expect(keyModules([graph("src/a.ts", [])], "/ws")).toBe("")
  })
})
