/**
 * Minimal loadout — the single source of truth for what an agent starts a turn
 * with, and the rule that derives which skills ride along with it.
 *
 * Everything else is discovered at runtime through `search_knowledge`, which
 * injects both the tool and its associated skill into the loadout
 * (context-compiler.ts). So a skill that documents tools outside this set has
 * nothing to teach a turn that hasn't discovered them yet — it only spends
 * context.
 *
 * These used to be two hand-maintained lists (one here, one in skill-selector)
 * and they drifted: they had already diverged to the point where one of them
 * pinned skills whose tools were not in the loadout, advertising capabilities
 * the model did not have. The skill set is now derived from the tool set so it
 * cannot.
 */

/** Tools always present in a generic agent's loadout, without discovery. */
export const MINIMAL_TOOLS = new Set([
  // Discovery — the entry point to everything else
  "search_knowledge",
  // Communication with the user
  "notify",
  "report_progress",
  // Notes that survive context compaction
  "save_note",
])

/**
 * What the coordinator always holds on top of the minimal set: the ways it acts.
 * Without these it can only talk — a real run showed BEE looping on
 * `report_progress` because `task_delegate` was in its profile but never loaded.
 */
export const COORDINATOR_PINNED_TOOLS = new Set(["task_delegate", "task_revise", "task_status"])

/** Splits a SkillDoc's comma-separated `tools` column into tool names. */
export function parseSkillTools(toolsCsv: string | null | undefined): string[] {
  return (toolsCsv ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
}

/**
 * A skill is minimal when every tool it documents is already in the loadout.
 * A skill that declares no tools is not minimal: it has no anchor to the
 * always-available set, so it belongs to discovery like any other.
 */
export function isMinimalSkill(toolsCsv: string | null | undefined): boolean {
  const tools = parseSkillTools(toolsCsv)
  return tools.length > 0 && tools.every((name) => MINIMAL_TOOLS.has(name))
}