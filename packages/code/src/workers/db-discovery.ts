/**
 * Dynamic sub-agent discovery from HiveDB.
 */

import { col } from "@johpaz/hivecode-core/storage/hive"
import type { AgentDoc } from "@johpaz/hivecode-core/storage/collections"
import { registerSubAgent } from "./subagent-registry"
import type { SubAgentDefinition } from "./subagent-registry"

export function discoverDynamicSubAgents(): number {
  void (async () => {
    try {
      const workers = (await (await col<AgentDoc>("agents")).findBy("role", "worker"))
        .map((entry) => entry.doc)
        .filter((worker) => worker.enabled)

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
      }
    } catch {
      // HiveDB may not be available in worker context.
    }
  })()
  return 0
}
