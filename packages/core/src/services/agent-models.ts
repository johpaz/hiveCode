import { col, mutateDoc, toIndexable } from "../storage/hive"
import type { AgentDoc } from "../storage/collections"

/**
 * Which model each agent runs.
 *
 * An agent either follows the session's model (`model_selection: "inherit"`) or has its own
 * (`"custom"`). Choosing the session's model used to write only the global default and leave every
 * agent in `custom` where it was — a BEE set to one model kept it after the person picked another
 * in Settings, so the choice seemed to do nothing.
 */

/** The agents that belong to the harness (BEE, scout, planner, builder, verifier, spider). */
async function coreAgentIds(): Promise<string[]> {
  return (await (await col<AgentDoc>("agents")).scan())
    .map(entry => entry.doc)
    .filter(agent => !!agent.agent_type && agent.status !== "archived")
    .map(agent => agent.id)
}

export interface ApplyModelResult {
  /** How many agents now follow the session's model. */
  updated: number
  /** The agents that had a model of their own and lost it. */
  replaced: string[]
}

/**
 * Makes every core agent follow `providerId/modelId`: the session's model, which the agents inherit.
 * Their stored provider and model mirror it, as for any agent that is not `custom`. An agent that
 * had a model of its own loses it; setting one again is a per-agent choice made afterwards.
 */
export async function applyModelToAllAgents(providerId: string, modelId: string, now = Date.now()): Promise<ApplyModelResult> {
  const replaced: string[] = []
  let updated = 0
  for (const id of await coreAgentIds()) {
    const next = await mutateDoc<AgentDoc>("agents", id, current => {
      if (!current) return null
      if (current.model_selection === "custom") replaced.push(id)
      return {
        ...current,
        model_selection: "inherit",
        provider_id: toIndexable(providerId),
        model_id: toIndexable(modelId),
        config_version: (current.config_version ?? 0) + 1,
        updated_at: now,
      }
    })
    if (next) updated++
  }
  return { updated, replaced }
}

/** The sentence that tells the person what choosing a model did to their agents. */
export function describeApplied(result: ApplyModelResult): string {
  if (result.updated === 0) return ""
  const base = `aplicado a ${result.updated} agentes`
  return result.replaced.length
    ? `${base} (sustituyó el modelo propio de ${result.replaced.join(", ")})`
    : base
}
