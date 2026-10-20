import {describe, expect, test} from "bun:test"
import {canExecuteTool, filterToolsByMode} from "./execution-mode"

describe("planning tools", () => {
  test("planning may delegate and revise specialist research", () => {
    for (const tool of ["task_delegate", "task_revise", "task_status", "spawn_agent", "get_project_context", "fs_read", "web_search", "web_fetch", "speckit_init", "speckit_artifact_write", "speckit_validate"]) {
      expect(canExecuteTool(tool, "plan")).toBe(true)
    }
    expect(filterToolsByMode([{name: "task_delegate"}, {name: "fs_write"}], "plan")).toEqual([{name: "task_delegate"}])
  })
  test("delegation does not grant implementation permission in plan mode", () => {
    for (const tool of ["fs_write", "fs_edit", "fs_delete", "shell_executor", "code_test", "code_build", "git_commit", "git_push", "agent_create", "agent_archive", "task_delegate_code"]) {
      expect(canExecuteTool(tool, "plan")).toBe(false)
      expect(canExecuteTool(tool, "approval")).toBe(true)
      expect(canExecuteTool(tool, "auto")).toBe(true)
    }
  })
})

describe("canPromptForConfirmation", () => {
  test("never prompts inside the TUI, whatever stdin looks like", async () => {
    const { canPromptForConfirmation } = await import("./execution-mode")
    const previous = process.env.HIVECODE_TUI
    try {
      process.env.HIVECODE_TUI = "1"
      expect(canPromptForConfirmation()).toBe(false)
      delete process.env.HIVECODE_TUI
      expect(canPromptForConfirmation()).toBe(process.stdin.isTTY === true)
    } finally {
      if (previous === undefined) delete process.env.HIVECODE_TUI
      else process.env.HIVECODE_TUI = previous
    }
  })
})
