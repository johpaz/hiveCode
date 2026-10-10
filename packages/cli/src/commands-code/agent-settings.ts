import { col, fromIndexable } from "@johpaz/hivecode-core/storage/hive"
import type { AgentDoc, CodeConfigDoc } from "@johpaz/hivecode-core/storage/collections"
import { listCatalogModels, listCatalogProviders } from "@johpaz/hivecode-core/services/provider-catalog-read"
import type { ModalField } from "./tui-launcher"

export const INHERIT_MODEL = "Usar modelo de la sesión"
function modelLabel(providerId: string, model: {id: string; name: string}): string {
  const value = `${providerId}/${model.id}`
  return model.name && model.name !== model.id ? `${model.name} · ${value}` : value
}

export async function agentConfigFields(profile: AgentDoc): Promise<ModalField[]> {
  const config = await col<CodeConfigDoc>("codeConfig")
  const selected = (await config.get("default_provider"))?.doc.value
  const providers = (await listCatalogProviders()).filter(provider => provider.enabled)
  providers.sort((a, b) => Number(b.id === selected) - Number(a.id === selected))
  const choices: string[] = [INHERIT_MODEL]
  let current: string | undefined
  for (const provider of providers) {
    for (const model of await listCatalogModels(provider.id)) {
      const label = modelLabel(provider.id, model)
      choices.push(label)
      if (provider.id === profile.provider_id && model.id === profile.model_id) current = label
    }
  }
  const text = (key: string, label: string, value: string): ModalField => ({
    key, label, placeholder: value, default_value: value, required: false, secret: false, field_type: "text",
  })
  return [
    {key: "model_choice", label: "Modelo · provider activo primero", placeholder: "", required: true, secret: false,
      field_type: "select", options: choices, default_value: profile.model_selection === "custom" && current ? current : INHERIT_MODEL},
    text("fallback_provider", "Provider fallback", fromIndexable(profile.fallback_provider_id) ?? ""),
    text("fallback_model", "Modelo fallback", fromIndexable(profile.fallback_model_id) ?? ""),
    {key: "effort", label: "Esfuerzo", placeholder: "", required: true, secret: false, field_type: "select", options: ["low", "medium", "high", "xhigh", "max"], default_value: profile.effort ?? "medium"},
    text("max_turns", "Máx. turnos", String(profile.max_iterations)),
    text("max_input_tokens", "Máx. tokens entrada", String(profile.max_input_tokens ?? 0)),
    text("max_output_tokens", "Máx. tokens salida", String(profile.max_output_tokens ?? 0)),
    text("max_cost_usd", "Costo máximo USD", String(profile.max_cost_usd ?? 0)),
    text("user_instructions", "Instrucciones adicionales", profile.user_instructions ?? ""),
  ]
}

export async function agentModelPatch(choice: string): Promise<Partial<AgentDoc>> {
  if (choice === INHERIT_MODEL) return {model_selection: "inherit"}
  for (const provider of (await listCatalogProviders()).filter(provider => provider.enabled)) {
    const model = (await listCatalogModels(provider.id)).find(model =>
      choice === `${provider.id}/${model.id}` || choice === modelLabel(provider.id, model))
    if (model) return {provider_id: provider.id, model_id: model.id, model_selection: "custom"}
  }
  throw new Error("El modelo elegido ya no está disponible en el catálogo; vuelve a abrir el editor")
}
