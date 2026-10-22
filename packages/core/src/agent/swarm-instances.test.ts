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

import { CORE_AGENT_DEFINITIONS } from "./agent-profiles"
import { REQUIRED_PROFILE_SKILLS } from "./specialties"

describe("core profiles declare the skills they load", () => {
  test("a profile's skills are its required skills, so a duplicate loads the same as its base", () => {
    for (const [id, required] of Object.entries(REQUIRED_PROFILE_SKILLS)) {
      expect(CORE_AGENT_DEFINITIONS[id as keyof typeof CORE_AGENT_DEFINITIONS].skills).toEqual(required)
    }
  })
})

import { NO_SPAWN_PROFILES } from "./agent-profiles"

describe("who may create agents", () => {
  test("scout and planner cannot, the coordinator and the writers can", () => {
    expect([...NO_SPAWN_PROFILES].sort()).toEqual(["planner", "scout"])
    for (const id of ["scout", "planner"] as const) expect(CORE_AGENT_DEFINITIONS[id].tools).not.toContain("spawn_agent")
    for (const id of ["bee", "builder", "verifier", "spider"] as const) expect(CORE_AGENT_DEFINITIONS[id].tools).toContain("spawn_agent")
  })
})
