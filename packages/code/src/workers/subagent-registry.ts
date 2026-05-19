/**
 * Sub-agent Registry — dynamic registration for sub-agent management.
 *
 * Supports both built-in sub-agents (defined in subagent-prompts.ts)
 * and dynamically registered agents from the database.
 * Coordinators can delegate to sub-agents in their domain.
 * Bee (the top-level orchestrator) can delegate to ALL sub-agents.
 */

import {
  SUBAGENT_PROMPTS,
  COORDINATOR_SUBAGENTS as BUILTIN_COORDINATOR_SUBAGENTS,
  getSubAgent as getBuiltinSubAgent,
  listSubAgents as listBuiltinSubAgents,
  isValidSubAgent as isValidBuiltinSubAgent,
} from "./subagent-prompts"
import type { SubAgentDefinition } from "./subagent-prompts"

export type { SubAgentDefinition }

/** Path to the sub-agent worker file */
export const SUBAGENT_WORKER_PATH = new URL("./subagent.worker.ts", import.meta.url).pathname

// ─── Dynamic Registry ─────────────────────────────────────────────────────────

const dynamicSubAgents = new Map<string, SubAgentDefinition>()
const dynamicCoordinatorSubAgents = new Map<string, string[]>()

/**
 * Register a dynamic sub-agent.
 * Dynamic sub-agents override built-in ones with the same name.
 */
export function registerSubAgent(agent: SubAgentDefinition, coordinatorDomain?: string): void {
  dynamicSubAgents.set(agent.name, agent)
  if (coordinatorDomain) {
    const existing = dynamicCoordinatorSubAgents.get(coordinatorDomain) || []
    if (!existing.includes(agent.name)) {
      existing.push(agent.name)
      dynamicCoordinatorSubAgents.set(coordinatorDomain, existing)
    }
  }
}

/**
 * Unregister a dynamic sub-agent.
 */
export function unregisterSubAgent(name: string, coordinatorDomain?: string): void {
  dynamicSubAgents.delete(name)
  if (coordinatorDomain) {
    const existing = dynamicCoordinatorSubAgents.get(coordinatorDomain) || []
    dynamicCoordinatorSubAgents.set(
      coordinatorDomain,
      existing.filter(n => n !== name)
    )
  }
}

/**
 * Register multiple sub-agents for a coordinator at once.
 * Merges with built-in sub-agents (does not replace them).
 */
export function registerCoordinatorSubAgents(coordinator: string, agentNames: string[]): void {
  const existing = dynamicCoordinatorSubAgents.get(coordinator) || []
  const merged = [...new Set([...existing, ...agentNames])]
  dynamicCoordinatorSubAgents.set(coordinator, merged)
}

// ─── Lookup Functions ──────────────────────────────────────────────────────────

/** Get all coordinator-to-subagent mappings (built-in + dynamic). */
export const COORDINATOR_SUBAGENTS: Record<string, string[]> = new Proxy({} as Record<string, string[]>, {
  get(_target, prop: string) {
    const builtin = BUILTIN_COORDINATOR_SUBAGENTS[prop] || []
    const dynamic = dynamicCoordinatorSubAgents.get(prop) || []
    return [...builtin, ...dynamic]
  },
  ownKeys(_target) {
    const keys = new Set<string>([
      ...Object.keys(BUILTIN_COORDINATOR_SUBAGENTS),
      ...dynamicCoordinatorSubAgents.keys(),
    ])
    return [...keys]
  },
  has(_target, prop: string) {
    return prop in BUILTIN_COORDINATOR_SUBAGENTS || dynamicCoordinatorSubAgents.has(prop)
  },
})

/**
 * Get a sub-agent definition by name.
 * Checks dynamic registry first, then built-in.
 */
export function getSubAgent(name: string): SubAgentDefinition | undefined {
  return dynamicSubAgents.get(name) || getBuiltinSubAgent(name)
}

/**
 * Check if a sub-agent is valid for a coordinator.
 * A sub-agent is valid if it's in the coordinator's domain list OR in the "bee" domain.
 */
export function isValidSubAgent(coordinator: string, subagent: string): boolean {
  if (coordinator === "bee") return true // Bee can delegate to any sub-agent
  const names = COORDINATOR_SUBAGENTS[coordinator] || []
  return names.includes(subagent)
}

/**
 * List all sub-agents available to a coordinator.
 * Bee sees all built-in + dynamic sub-agents.
 */
export function listSubAgents(coordinator: string): SubAgentDefinition[] {
  if (coordinator === "bee") {
    // Bee can delegate to all built-in + all dynamic sub-agents
    const allNames = [...new Set([...Object.values(BUILTIN_COORDINATOR_SUBAGENTS).flat(), ...dynamicSubAgents.keys()])]
    return allNames.map(n => getSubAgent(n)).filter((a): a is SubAgentDefinition => a !== undefined)
  }

  const names = COORDINATOR_SUBAGENTS[coordinator] || []
  return names.map(n => getSubAgent(n)).filter((a): a is SubAgentDefinition => a !== undefined)
}

// ─── Re-export built-in definitions for convenience ─────────────────────────────

export { SUBAGENT_PROMPTS }