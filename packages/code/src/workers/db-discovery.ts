/**
 * Database Discovery — auto-discovers worker agents from the database
 * and registers them as dynamic sub-agents.
 *
 * This bridges the agents table (role='worker') with the sub-agent registry,
 * allowing dynamically created agents to be available for delegation.
 */

import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { registerSubAgent } from "./subagent-registry"
import type { SubAgentDefinition } from "./subagent-registry"

/**
 * Discover worker agents from the database and register them as dynamic sub-agents.
 * Called once during coordinator startup.
 */
export function discoverDynamicSubAgents(): number {
  let count = 0
  try {
    const db = getDb()
    const workers = db.query<{
      id: string
      name: string
      description: string | null
      system_prompt: string | null
      parent_id: string | null
    }, []>(`
      SELECT id, name, description, system_prompt, parent_id
      FROM agents
      WHERE role = 'worker' AND enabled = 1
    `).all()

    for (const worker of workers) {
      if (!worker.system_prompt) continue

      const agentName = `custom-${worker.name.toLowerCase().replace(/\s+/g, "-")}`
      const def: SubAgentDefinition = {
        name: agentName,
        description: worker.description || worker.name,
        systemPrompt: worker.system_prompt,
        maxTokens: 4096,
        temperature: 0.2,
      }

      const coordinatorDomain = worker.parent_id ? undefined : "bee"
      registerSubAgent(def, coordinatorDomain)
      count++
    }
  } catch {
    // DB may not be available in worker context
  }
  return count
}