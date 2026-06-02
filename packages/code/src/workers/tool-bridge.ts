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

/** Minimum viable toolset for every coordinator — everything else discovered via search_knowledge */
const MINIMAL_TOOLSET = [
  "get_project_context", // global project summary: structure, modules, ADRs
  "search_knowledge",    // discover tools, skills, playbook, MCP, code
  "fs_read",             // fundamental: read files
  "shell_executor",      // fundamental: run commands
  "save_note",           // persistent notes
  "notify",              // user communication
  "report_progress",     // progress updates
]

/** Tools available to each coordinator (by name).
 *  Nivel 2 (puro): workers start with MINIMAL_TOOLSET and discover the rest
 *  dynamically via search_knowledge. The CoordinatorManager injects allTools
 *  so the worker can add discovered tools to its loadout after each turn. */
export const COORDINATOR_TOOLS: Record<PhaseName, string[]> = {
  bee: [
    ...MINIMAL_TOOLSET,
    // BEE also needs direct write access for simple fixes (respond/fix actions)
    "fs_write", "fs_edit", "fs_delete",
    "git_commit", "git_branch",
    "check_types", "code_build", "code_test", "code_lint",
    "run_script",
    "append_narrative", "write_decision",
    "browser_screenshot", "browser_preview_html",
    "browser_navigate", "browser_click", "browser_type",
    "browser_extract", "browser_script", "browser_wait",
  ],
  architecture: [
    ...MINIMAL_TOOLSET,
    "write_decision",
  ],
  backend: [
    ...MINIMAL_TOOLSET,
  ],
  frontend: [
    ...MINIMAL_TOOLSET,
  ],
  security: [
    ...MINIMAL_TOOLSET,
  ],
  test: [
    ...MINIMAL_TOOLSET,
  ],
  devops: [
    ...MINIMAL_TOOLSET,
  ],
  dba: [
    ...MINIMAL_TOOLSET,
    "write_decision",
  ],
  integration: [
    ...MINIMAL_TOOLSET,
    "write_decision",
  ],
  reviewer: [
    ...MINIMAL_TOOLSET,
    "write_decision",
  ],
  librarian: [
    ...MINIMAL_TOOLSET,
    "write_memory",
  ],
  forensic: [
    ...MINIMAL_TOOLSET,
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
    ...MINIMAL_TOOLSET,
  ],
  data_scientist: [
    ...MINIMAL_TOOLSET,
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
