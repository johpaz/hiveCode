import { describe, expect, test } from "bun:test"
import { keyModules } from "./project-context"

const graph = (file: string, importedBy: string[], exports: string[] = []) => ({
  file_path: file, exported_by: JSON.stringify(importedBy), exports: JSON.stringify(exports), functions: "[]", classes: "[]",
}) as any

describe("keyModules", () => {
  test("lists the most imported files first, with a few exports", () => {
    const out = keyModules([
      graph("src/leaf.ts", []),
      graph("src/core.ts", ["a", "b", "c"], ["run", "stop"]),
      graph("src/util.ts", ["a"], ["pad"]),
    ])
    expect(out.split("\n")).toEqual([
      "- src/core.ts (3 importers) → run, stop",
      "- src/util.ts (1 importers) → pad",
    ])
  })

  test("caps the list and tolerates unreadable rows", () => {
    const rows = Array.from({ length: 30 }, (_, i) => graph(`src/f${i}.ts`, ["x"]))
    rows.push({ file_path: "bad.ts", exported_by: "{nope", exports: "{nope" } as any)
    expect(keyModules(rows).split("\n").length).toBe(10)
  })

  test("is empty when nothing is imported", () => {
    expect(keyModules([graph("src/a.ts", [])])).toBe("")
  })
})

import { mentionedAreas } from "./project-context"

describe("mentionedAreas", () => {
  const rows = [
    graph("packages/core/src/harness/profile-harness.ts", ["a", "b"], ["ProfileHarness", "run"]),
    graph("packages/core/src/harness/task-weight.ts", ["a"], ["decideTier"]),
    graph("packages/core/src/agent/loop.ts", ["a", "b", "c"], ["runAgent"]),
    graph("docs/harness.md", []),
  ]

  test("lists the files under a directory the task names, most imported first", () => {
    const out = mentionedAreas("Revisa packages/core/src/harness y dime los riesgos.", rows)
    expect(out.split("\n")).toEqual([
      "packages/core/src/harness — 2 file(s):",
      "- packages/core/src/harness/profile-harness.ts (2 importers) → ProfileHarness, run",
      "- packages/core/src/harness/task-weight.ts (1 importers) → decideTier",
    ])
  })

  test("accepts a single file and ignores a path the index does not know", () => {
    expect(mentionedAreas("mira packages/core/src/agent/loop.ts", rows)).toContain("- packages/core/src/agent/loop.ts (3 importers) → runAgent")
    expect(mentionedAreas("mira src/nada/aqui.ts", rows)).toBe("")
  })

  test("a task with no path names no area", () => {
    expect(mentionedAreas("revisa el arnés", rows)).toBe("")
  })
})
