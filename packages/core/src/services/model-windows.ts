import { col, mutateDoc } from "../storage/hive"
import type { ModelDoc } from "../storage/collections"
import { knownContextWindow } from "../storage/seed"

/**
 * Corrects the context window of models whose provider does not publish it.
 *
 * OpenCode Go's `/models` lists ids only, so the catalog sync wrote the 32 768 default and — because
 * the seed only inserts what is missing — nothing ever fixed it: the header kept showing 32.8 k for a
 * model that really holds 1 M, and the agent compacted and capped its answers to match. The curated
 * catalog knows the real window (`knownContextWindow`); this applies it to the rows that already exist.
 *
 * Only providers with a curated table are touched; a window the provider itself reports (Gemini,
 * Anthropic…) is never overridden here.
 */
export async function repairKnownContextWindows(): Promise<number> {
  const rows = (await (await col<ModelDoc>("models")).scan()).map(entry => entry.doc)
  let repaired = 0
  for (const model of rows) {
    const wireId = model.catalog_wire_id ?? (model.id.startsWith(`${model.provider_id}/`) ? model.id.slice(model.provider_id.length + 1) : model.id)
    const known = knownContextWindow(model.provider_id, wireId)
    if (!known || model.context_window === known) continue
    await mutateDoc<ModelDoc>("models", model.id, current => current && { ...current, context_window: known })
    repaired++
  }
  return repaired
}
