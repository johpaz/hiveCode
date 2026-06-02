/**
 * Tool Bridge — connects coordinator workers to the main thread tool registry.
 *
 * Each coordinator gets a curated subset of tools.
 * Tools are executed in the main thread (serialised access to filesystem/git).
 */

import type { Tool } from "@johpaz/hivecode-core/tools"
import type { LLMToolDef } from "@johpaz/hivecode-core/agent/llm-client"
import type { PhaseName, SessionMode } from "./types"

// Re-export for convenience
export type { Tool }

/** Tools available to each coordinator (by name) */
export const COORDINATOR_TOOLS: Record<PhaseName, string[]> = {
  bee: [
    // Context gathering (always available)
    "fs_read", "fs_list", "fs_exists", "fs_glob",
    "code_search", "parse_ast", "read_narrative",
    "git_status", "git_diff", "git_log",
    // Write tools — BEE uses these for simple direct fixes
    "fs_write", "fs_edit", "fs_delete",
    "git_commit", "git_branch",
    "check_types", "code_build", "code_test", "code_test_parallel", "code_lint",
    "run_script", "shell_executor",
    "append_narrative", "write_decision",
    // Browser preview — verify generated web output before reporting done
    "browser_screenshot", "browser_preview_html",
    // agent-browser: accessibility-tree automation (navigate, interact, extract)
    "browser_navigate", "browser_click", "browser_type",
    "browser_extract", "browser_script", "browser_wait",
  ],
  architecture: [
    "fs_read",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "code_search",
    "parse_ast",
    "read_narrative",
    "write_decision",
    "check_types",
  ],
  backend: [
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_delete",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "git_status",
    "git_diff",
    "git_commit",
    "git_branch",
    "code_search",
    "code_build",
    "code_test",
    "code_test_parallel",
    "code_lint",
    "parse_ast",
    "check_types",
    "run_script",
    "read_narrative",
    "append_narrative",
    "shell_executor",
  ],
  frontend: [
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_delete",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "git_status",
    "git_diff",
    "git_commit",
    "code_search",
    "code_build",
    "code_test",
    "code_test_parallel",
    "code_lint",
    "parse_ast",
    "check_types",
    "run_script",
    "read_narrative",
    "append_narrative",
    "shell_executor",
    "browser_screenshot",
    "browser_preview_html",
    "browser_navigate", "browser_click", "browser_type",
    "browser_extract", "browser_script", "browser_wait",
  ],
  security: [
    "fs_read",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "code_search",
    "parse_ast",
    "check_dependencies",
    "read_narrative",
  ],
  test: [
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "git_status",
    "code_search",
    "code_test",
    "code_test_parallel",
    "code_build",
    "parse_ast",
    "check_types",
    "run_script",
    "read_narrative",
    "append_narrative",
    "shell_executor",
    "browser_screenshot",
    "browser_preview_html",
    "browser_navigate", "browser_click", "browser_type",
    "browser_extract", "browser_script", "browser_wait",
  ],
  devops: [
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "git_status",
    "git_diff",
    "git_commit",
    "git_branch",
    "git_create_pr",
    "git_rollback",
    "code_build",
    "code_test",
    "code_test_parallel",
    "code_lint",
    "read_narrative",
    "append_narrative",
    "shell_executor",
  ],
  dba: [
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "code_search",
    "parse_ast",
    "read_narrative",
    "write_decision",
    "append_narrative",
    "shell_executor",
  ],
  integration: [
    "fs_read",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "code_search",
    "parse_ast",
    "read_narrative",
    "write_decision",
    "append_narrative",
  ],
  reviewer: [
    "fs_read",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "code_search",
    "parse_ast",
    "git_status",
    "git_diff",
    "git_log",
    "read_narrative",
    "write_decision",
    "check_types",
    "code_test",
  ],
  librarian: [
    "fs_read",
    "fs_list",
    "fs_glob",
    "read_narrative",
    "write_memory",
  ],
  forensic: [
    "fs_read",
    "fs_list",
    "fs_glob",
    "code_search",
    "parse_ast",
    "read_narrative",
  ],
  product_manager: [
    "fs_read",
    "fs_list",
    "fs_glob",
    "code_search",
    "read_narrative",
    "write_decision",
    "append_narrative",
  ],
  mobile: [
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "code_search",
    "parse_ast",
    "code_build",
    "code_test",
    "run_script",
    "read_narrative",
    "append_narrative",
    "shell_executor",
    "browser_screenshot",
    "browser_navigate", "browser_extract",
  ],
  data_scientist: [
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_list",
    "fs_exists",
    "fs_glob",
    "code_search",
    "parse_ast",
    "run_script",
    "read_narrative",
    "append_narrative",
    "shell_executor",
  ],
}

/** Convert Hive Tool → LLMToolDef for the LLM client */
export function toolToLLMToolDef(tool: Tool): LLMToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }
}

/** Meta-tools handled directly by the manager (not in allTools) */
const BEE_META_TOOLS: LLMToolDef[] = [
  {
    type: "function",
    function: {
      name: "set_session_mode",
      description: "Cambia el modo de ejecución de la sesión actual. Llámalo después de preguntar al usuario qué modo prefiere.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["auto", "plan", "approval"],
            description: "auto=ejecuta directo · plan=presenta plan y espera aprobación · approval=aprobación fase por fase",
          },
          reason: {
            type: "string",
            description: "Por qué se cambia el modo (para el log)",
          },
        },
        required: ["mode"],
      },
    },
  },
]

/** Get tools for a specific coordinator */
export function getToolsForCoordinator(
  phase: PhaseName,
  allTools: Tool[]
): LLMToolDef[] {
  const allowed = new Set(COORDINATOR_TOOLS[phase])
  const tools = allTools
    .filter(t => allowed.has(t.name))
    .map(toolToLLMToolDef)
  if (phase === "bee") return [...tools, ...BEE_META_TOOLS]
  return tools
}

/** Execute a tool by name from the available tools list */
export async function executeToolByName(
  allTools: Tool[],
  toolName: string,
  args: Record<string, unknown>,
  config?: any
): Promise<unknown> {
  const tool = allTools.find(t => t.name === toolName)
  if (!tool?.execute) {
    return { ok: false, error: `Tool '${toolName}' not found or not executable` }
  }
  try {
    return await tool.execute(args, config)
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      tool: toolName,
    }
  }
}

/** Check if a tool is allowed for a coordinator in a given mode */
export function isToolAllowed(
  toolName: string,
  phase: PhaseName,
  mode: SessionMode
): boolean {
  const allowed = COORDINATOR_TOOLS[phase]
  if (!allowed.includes(toolName)) return false

  // In plan mode, code/worktree mutations are blocked. Blackboard writes
  // (append_narrative/write_decision) remain allowed for PRD/ADR capture.
  if (mode === "plan") {
    const writeTools = new Set([
      "fs_write",
      "fs_edit",
      "fs_delete",
      "git_commit",
      "git_branch",
      "git_create_pr",
      "git_rollback",
    ])
    if (writeTools.has(toolName)) return false
  }

  return true
}
