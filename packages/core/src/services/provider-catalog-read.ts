import { col, ensureIndexes } from "../storage/hive"
import type { ModelDoc, ProviderDoc } from "../storage/collections"

/** Shared DB catalog consumed by onboarding, CLI settings and the TUI. */
export async function listCatalogProviders(): Promise<ProviderDoc[]> {
  return (await (await col<ProviderDoc>("providers")).scan())
    .map(row => row.doc)
    .filter(provider => provider.category === "llm")
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A model a person may pick: a chat model that is enabled and that its provider still lists. A model
 * the provider dropped is hidden from the first sync that misses it (`catalog_missing_since_slot`),
 * well before it is retired — so every list, picker and check shares this one rule. Each used its own
 * before, and the picker went on offering models the gateway no longer published.
 */
export function isSelectableModel(model: ModelDoc): boolean {
  return model.model_type === "llm" && model.enabled && model.deprecated_at == null && model.catalog_missing_since_slot == null
}

export async function listCatalogModels(providerId: string): Promise<ModelDoc[]> {
  await ensureIndexes([["models", "provider_id"]])
  return (await (await col<ModelDoc>("models")).findBy("provider_id", providerId))
    .map(row => row.doc)
    .filter(isSelectableModel)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listModelChoices(providerId: string): Promise<{ value: string; label: string }[]> {
  return (await listCatalogModels(providerId)).map(model => ({ value: model.id, label: model.name }));
}
