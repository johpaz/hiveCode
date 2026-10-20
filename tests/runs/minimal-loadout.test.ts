/**
 * minimal-loadout — the derived skill set.
 *
 * The failure this pins is a real one that already happened: a skill was pinned
 * as always-available while documenting tools the agent did not have, so its
 * instructions described capabilities that did not exist and pushed the model
 * toward a tool it could not call. Deriving the set from the tools removes the
 * possibility rather than fixing one instance of it.
 */
import { describe, expect, test } from "bun:test"
import { MINIMAL_TOOLS, isMinimalSkill, parseSkillTools } from "@johpaz/hivecode-core/agent/minimal-loadout"

describe("MINIMAL_TOOLS", () => {
  test("discovery is always present — it is the way out of the minimal set", () => {
    expect(MINIMAL_TOOLS.has("search_knowledge")).toBe(true)
  })

  test("nothing that mutates the workspace belongs here", () => {
    for (const name of MINIMAL_TOOLS) {
      expect(name).not.toMatch(/^(fs_write|fs_edit|shell_executor|git_)/)
    }
  })
})

describe("parseSkillTools", () => {
  test("splits, trims and drops empties", () => {
    expect(parseSkillTools(" fs_read , fs_write ,, fs_list ")).toEqual(["fs_read", "fs_write", "fs_list"])
  })

  test("null and undefined are empty, not a crash", () => {
    expect(parseSkillTools(null)).toEqual([])
    expect(parseSkillTools(undefined)).toEqual([])
  })
})

describe("isMinimalSkill", () => {
  test("a skill documenting only minimal tools is minimal", () => {
    expect(isMinimalSkill("save_note,notify")).toBe(true)
    expect(isMinimalSkill("search_knowledge")).toBe(true)
  })

  test("one non-minimal tool disqualifies the whole skill", () => {
    expect(isMinimalSkill("save_note,memory_write")).toBe(false)
  })

  test("the memory_manager shape that caused the drift", () => {
    // It documents memory_*, none of which are in MINIMAL_TOOLS, so pinning it
    // advertised tools the model did not have.
    expect(isMinimalSkill("memory_write,memory_read,memory_list")).toBe(false)
  })

  test("a skill with no tools is not minimal", () => {
    // No anchor to the always-available set — it belongs to discovery.
    expect(isMinimalSkill("")).toBe(false)
    expect(isMinimalSkill(null)).toBe(false)
  })

  test("the derived set is a subset of what the loadout actually carries", () => {
    // Guards the invariant the module exists for: no skill is ever pinned
    // alongside a tool the loadout does not have.
    for (const tools of ["save_note,notify", "report_progress", "search_knowledge,save_note"]) {
      for (const tool of parseSkillTools(tools)) {
        expect(MINIMAL_TOOLS.has(tool)).toBe(true)
      }
    }
  })
})