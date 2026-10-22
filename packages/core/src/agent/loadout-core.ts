/**
 * The smallest set of tools and skills each core role starts with. Everything else it may use comes from the
 * database (see `computeLoadout`) or from `search_knowledge`, which every role has.
 *
 * This is a hypothesis about what each role needs on its first turn, checked against what runs actually used
 * (`harness/loadout-learning.ts`); a role's *envelope* (agent-profiles.ts) stays the ceiling, a loadout never exceeds it.
 * Writing tools are in the core of the roles that write: a tool that edits is not something to go searching for.
 */

export interface RoleCore {
  tools: string[]
  skills: string[]
}

/** Reads the project through the index first, the disk by range second. */
const READ = ["get_project_context", "outline", "find_symbol", "dependents", "tests_for", "fs_read", "search_in_files"]
const SPECKIT_WRITE = ["speckit_init", "speckit_artifact_read", "speckit_artifact_write", "speckit_validate"]

export const LOADOUT_CORE: Record<string, RoleCore> = {
  bee: {
    // The coordinator orchestrates: it reads the project through the index and acts by delegating.
    tools: ["get_project_context", "outline", "find_symbol", "dependents", "task_delegate", "task_revise", "task_status", "report_progress", "save_note", "notify"],
    skills: ["busqueda_hivedb", "task_orchestrator"],
  },
  scout: { tools: READ, skills: ["busqueda_hivedb", "file_read_and_summarize"] },
  planner: { tools: [...READ, ...SPECKIT_WRITE, "save_note"], skills: ["busqueda_hivedb", "spec-kit"] },
  builder: {
    tools: ["get_project_context", "outline", "find_symbol", "fs_read", "search_in_files", "fs_edit", "fs_write", "shell_executor", "code_test", "check_types", "report_progress"],
    skills: ["busqueda_hivedb", "test_driven_development"],
  },
  verifier: {
    tools: ["get_project_context", "outline", "find_symbol", "fs_read", "search_in_files", "shell_executor", "code_test", "check_types", "code_build", "speckit_validate", "speckit_converge", "report_progress"],
    skills: ["busqueda_hivedb", "test_driven_development"],
  },
  spider: {
    tools: ["web_search", "web_fetch", "api_request", "browser_navigate", "browser_snapshot", "browser_markdown", "browser_interactive_elements", "browser_click", "browser_type", "browser_extract", "save_note", "report_progress"],
    skills: ["busqueda_hivedb", "web_research"],
  },
}

/** Every role can always reach the database. */
export const ALWAYS_TOOLS = ["search_knowledge"]

/**
 * What the coordinator also holds, by the route the harness chose. A direct change is made by BEE itself, so it carries the
 * writing tools; a feature is delegated, so it carries the Spec Kit contract and enough reading to judge what comes back; a
 * reading or planning request is delegated entirely and adds nothing. With no route (no harness task) it keeps all of them.
 */
export const COORDINATOR_BY_ROUTE: Record<string, string[]> = {
  scoped: ["fs_read", "fs_list", "fs_glob", "search_in_files", "fs_edit", "fs_write", "shell_executor", "check_types", "code_test", "spawn_agent"],
  feature: ["fs_read", "search_in_files", "spawn_agent", "speckit_artifact_read", "speckit_validate", "speckit_converge"],
  conversation: [],
}
export const COORDINATOR_UNKNOWN_ROUTE: string[] = [...COORDINATOR_BY_ROUTE.scoped, "speckit_artifact_read", "speckit_validate", "speckit_converge"]

/** Tools a specialty brings on top of its role's core (those outside the role's envelope are dropped afterwards). */
export const SPECIALTY_TOOLS: Record<string, string[]> = {
  backend: ["code_build", "run_script", "git_status", "git_diff"],
  data: ["code_build", "run_script", "git_status", "git_diff"],
  devops: ["code_build", "run_script", "git_status", "git_diff", "git_log"],
  frontend: ["code_build", "browser_navigate", "browser_snapshot", "browser_screenshot", "browser_click"],
  integration: ["code_build", "run_script", "git_status", "git_diff"],
  security: ["git_diff", "git_log", "git_status"],
  acceptance: ["code_build", "run_script", "git_diff"],
}
