/**
 * Onboarding wizard — first-time setup for hivecode.
 *
 * hivecode onboard
 */

import {
  hiveIntro, hiveOutro, hiveNote, isCancel,
  runProviderSetupWizard,
} from "../cli-ui.ts"

import { storeProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"
import { maybeLoadHiveAgentsModelFromDb } from "@johpaz/hivecode-core/agent/hiveagents-loader"
import {
  listProviderIds,
  modelExists,
  setCoordinatorProviderModel,
  setDefaultProvider,
  setProviderModel,
  upsertProvider,
} from "./provider-store"

const VERSION = "1.0.0"

export async function onboard(version = VERSION): Promise<void> {
  hiveIntro(`hivecode  v${version}`)

  const existing = await listProviderIds()

  if (existing.length > 0) {
    hiveNote("Providers existentes", [
      ...existing.map((id) => `  · ${id}`),
      "",
      "El onboarding configurará un nuevo provider.",
      "Si quieres editar uno existente usa: hivecode provider edit",
    ])
  }

  const result = await runProviderSetupWizard(existing, version)
  if (!result) {
    hiveOutro("Onboarding cancelado", "error")
    return
  }

  await storeProviderApiKey(result.provider, result.apiKey)

  await upsertProvider(result.provider, {
    name: result.provider,
    baseUrl: result.baseUrl || null,
    enabled: true,
  })

  await setDefaultProvider(result.provider)

  if (result.model) {
    await setProviderModel(result.provider, result.model)
  }

  const agentModelId = result.model
    ? (await modelExists(result.model) ? result.model : null)
    : null
  await setCoordinatorProviderModel(result.provider, agentModelId)

  if (result.provider === "hiveagents" && agentModelId) {
    hiveNote("HiveAgents", [`Cargando ${agentModelId}; se esperará hasta que esté listo...`])
    const load = await maybeLoadHiveAgentsModelFromDb(result.provider, agentModelId)
    if (!load.success) {
      hiveNote("HiveAgents", [`No se pudo precargar ${agentModelId}: ${load.error}`])
    } else {
      hiveNote("HiveAgents", [`Modelo ${agentModelId} cargado y listo · ctx=${load.ctx}`])
    }
  }

  hiveOutro(`Onboarding completo · Provider ${result.provider} configurado`)
}
