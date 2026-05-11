/**
 * Tool Bridge — connects coordinator workers to the main thread tool registry.
 *
 * Each coordinator gets a curated subset of tools.
 * Tools are executed in the main thread (serialised access to filesystem/git).
 */

import type { Tool } from "@johpaz/hive-code-core/tools/types"
import type { LLMToolDef } from "@johpaz/hive-code-core/agent/llm-client"
import type { PhaseName } from "./types"

// Re-export for convenience
export type { Tool }

/** Tools available to each coordinator (by name) */
export const COORDINATOR_TOOLS: Record<PhaseName, string[]> = {
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
    "code_lint",
    "parse_ast",
    "check_types",
    "run_script",
    "read_narrative",
    "append_narrative",
    "shell_executor",
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
    "code_build",
    "parse_ast",
    "check_types",
    "run_script",
    "read_narrative",
    "append_narrative",
    "shell_executor",
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
    "code_lint",
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

/** Get tools for a specific coordinator */
export function getToolsForCoordinator(
  phase: PhaseName,
  allTools: Tool[]
): LLMToolDef[] {
  const allowed = new Set(COORDINATOR_TOOLS[phase])
  return allTools
    .filter(t => allowed.has(t.name))
    .map(toolToLLMToolDef)
}

/** Execute a tool by name from the available tools list */
export async function executeToolByName(
  allTools: Tool[],
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = allTools.find(t => t.name === toolName)
  if (!tool?.execute) {
    return { ok: false, error: `Tool '${toolName}' not found or not executable` }
  }
  try {
    return await tool.execute(args)
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

  // In plan mode, only read-only tools are allowed
  if (mode === "plan") {
    const writeTools = new Set([
      "fs_write",
      "fs_edit",
      "fs_delete",
      "git_commit",
      "git_branch",
      "git_create_pr",
      "git_rollback",
      "append_narrative",
      "write_decision",
    ])
    if (writeTools.has(toolName)) return false
  }

  return true
}
