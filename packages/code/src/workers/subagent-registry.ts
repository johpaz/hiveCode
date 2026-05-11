/**
 * Sub-agent Registry — lightweight registry for sub-agent management.
 *
 * Re-exports from subagent-prompts.ts for convenience.
 */

export {
  SUBAGENT_PROMPTS,
  COORDINATOR_SUBAGENTS,
  getSubAgent,
  isValidSubAgent,
  listSubAgents,
} from "./subagent-prompts"
export type { SubAgentDefinition } from "./subagent-prompts"

/** Path to the sub-agent worker file */
export const SUBAGENT_WORKER_PATH = new URL("./subagent.worker.ts", import.meta.url).pathname
