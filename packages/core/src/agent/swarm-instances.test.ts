import { describe, expect, test } from "bun:test"
import { canWriteWorkspace } from "./swarm-instances"

describe("canWriteWorkspace", () => {
  test("a reader needs no private worktree", () => {
    expect(canWriteWorkspace({ tools_json: JSON.stringify(["fs_read", "search_knowledge", "get_project_context"]) })).toBe(false)
  })

  test("any writing tool makes it a writer", () => {
    expect(canWriteWorkspace({ tools_json: JSON.stringify(["fs_read", "fs_edit"]) })).toBe(true)
    expect(canWriteWorkspace({ tools_json: JSON.stringify(["fs_read", "shell_executor"]) })).toBe(true)
  })

  test("no tool list, or an unreadable one, is treated as a writer", () => {
    expect(canWriteWorkspace({ tools_json: null })).toBe(true)
    expect(canWriteWorkspace({ tools_json: "{not json" })).toBe(true)
  })
})
