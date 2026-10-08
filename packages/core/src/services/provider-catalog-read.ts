import { col, ensureIndexes } from "../storage/hive"
import type { ModelDoc, ProviderDoc } from "../storage/collections"

/** Shared DB catalog consumed by onboarding, CLI settings and the TUI. */
export async function listCatalogProviders(): Promise<ProviderDoc[]> {
  return (await (await col<ProviderDoc>("providers")).scan())
    .map(row => row.doc)
    .filter(provider => provider.category === "llm")
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listCatalogModels(providerId: string): Promise<ModelDoc[]> {
  await ensureIndexes([["models", "provider_id"]])
  return (await (await col<ModelDoc>("models")).findBy("provider_id", providerId))
    .map(row => row.doc)
    .filter(model => model.model_type === "llm" && model.enabled && model.deprecated_at == null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listModelChoices(providerId: string): Promise<{ value: string; label: string }[]> {
  return (await listCatalogModels(providerId)).map(model => ({ value: model.id, label: model.name }));
}
