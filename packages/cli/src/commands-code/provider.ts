/**
 * Provider commands — manage LLM providers and API keys.
 *
 * hivecode provider list
 * hivecode provider add [name]
 * hivecode provider edit <name>
 * hivecode provider remove <name>
 * hivecode provider set-default <name>
 * hivecode provider set-model <provider> <model>
 * hivecode provider test <name>
 */

import {
  hiveIntro, hiveOutro,
  hiveNote, hiveSpinner, hiveText, hiveSelect, isCancel,
  runProviderSetupWizard,
} from "../cli-ui.ts"

const VERSION = "1.0.0"
import { deleteProviderApiKey, getProviderApiKey, storeProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"
import {
  HIVEAGENTS_MODEL_ID,
  HIVEAGENTS_OPENAI_BASE_URL,
  maybeLoadHiveAgentsModelFromDb,
} from "@johpaz/hivecode-core/agent/hiveagents-loader"
import {
  deleteProvider,
  getAllProviderModels,
  getDefaultProvider,
  getProvider,
  getProviderModel,
  listModelChoices,
  listProviderIds,
  listProviders,
  setDefaultProvider,
  setProviderModel,
  upsertProvider,
} from "./provider-store"

async function maybePreloadHiveAgents(providerId: string, modelId: string | undefined): Promise<void> {
  if (providerId !== "hiveagents" || !modelId) return
  const spinner = hiveSpinner("default")
  spinner.start(`Cargando ${HIVEAGENTS_MODEL_ID}...`)
  const load = await maybeLoadHiveAgentsModelFromDb(providerId, modelId)
  if (!load.success) {
    spinner.stop(`No se pudo cargar ${HIVEAGENTS_MODEL_ID}`, "error")
    hiveNote("HiveAgents", [`No se pudo precargar ${modelId}: ${load.error}`])
  } else {
    spinner.stop(`${HIVEAGENTS_MODEL_ID} listo`)
    hiveNote("HiveAgents", [`Modelo cargado y listo · ctx=${load.ctx}`])
  }
}

export async function providerList(): Promise<void> {
  const rows = await listProviders()

  hiveIntro("hivecode · Providers")

  if (rows.length === 0) {
    hiveNote("Sin providers", ["No hay providers configurados.", "Usa: hivecode provider add <name>"])
    hiveOutro("Sin providers")
    return
  }

  const defaultProvider = await getDefaultProvider()
  const modelMap = await getAllProviderModels()

  const lines = rows.map((r) => {
    const mark   = r.enabled ? "●" : "○"
    const def    = defaultProvider === r.id ? " ★" : "  "
    const model  = modelMap.get(r.id) ?? "default"
    const url    = r.base_url ?? "—"
    return `${mark}${def} ${r.id.padEnd(12)}  ${model.padEnd(24)}  ${url}`
  })
  hiveNote(`${rows.length} provider${rows.length === 1 ? "" : "s"}  ·  default: ${defaultProvider || "—"}`, lines)

  const action = await hiveSelect({
    message: "¿Qué deseas hacer?",
    options: [
      { value: "exit",   label: "Salir" },
      { value: "set",    label: "Cambiar provider por defecto" },
      { value: "delete", label: "Eliminar provider" },
      { value: "add",    label: "Agregar provider" },
    ],
  })

  if (isCancel(action) || action === "exit") {
    hiveOutro("Listo")
    return
  }

  if (action === "set") {
    const sel = await hiveSelect({
      message: "Provider por defecto:",
      options: rows.map((r) => ({
        value: r.id,
        label: `${r.id}${defaultProvider === r.id ? " (actual)" : ""}`,
      })),
    })
    if (!isCancel(sel)) {
      await setDefaultProvider(sel as string)
      hiveOutro(`${sel} es ahora el provider por defecto`)
    }
    return
  }

  if (action === "delete") {
    const sel = await hiveSelect({
      message: "Provider a eliminar:",
      options: rows.map((r) => ({ value: r.id, label: r.id })),
    })
    if (!isCancel(sel)) {
      await deleteProviderApiKey(sel as string)
      await deleteProvider(sel as string)
      hiveOutro(`Provider ${sel} eliminado`)
    }
    return
  }

  if (action === "add") {
    const known = rows.map((r) => r.id)
    const result = await runProviderSetupWizard(known, VERSION)
    if (!result) { hiveOutro("Cancelado", "error"); return }
    await storeProviderApiKey(result.provider, result.apiKey)
    await upsertProvider(result.provider, {
      name: result.provider,
      baseUrl: result.baseUrl || null,
      enabled: true,
    })
    if (result.model) {
      await setProviderModel(result.provider, result.model)
    }
    await maybePreloadHiveAgents(result.provider, result.model)
    hiveOutro(`Provider ${result.provider} agregado`)
  }
}

export async function providerAdd(name?: string): Promise<void> {
  const knownProviders = await listProviderIds()

  const result = await runProviderSetupWizard(knownProviders, VERSION, name)
  if (!result) return

  await storeProviderApiKey(result.provider, result.apiKey)
  await upsertProvider(result.provider, {
    name: result.provider,
    baseUrl: result.baseUrl || null,
    enabled: true,
  })

  if (result.model) {
    await setProviderModel(result.provider, result.model)
  }

  await maybePreloadHiveAgents(result.provider, result.model)
}

export async function providerRemove(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode provider remove <name>", "error")
    process.exit(1)
  }

  const row = await getProvider(name)

  if (!row) {
    hiveOutro(`Provider no encontrado: ${name}`, "error")
    process.exit(1)
  }

  await deleteProviderApiKey(name)
  await deleteProvider(name)
  hiveOutro(`Provider ${name} eliminado`)
}

export async function providerEdit(name?: string): Promise<void> {
  hiveIntro("hivecode · Editar Provider")

  let providerId = name
  if (!providerId) {
    const rows = await listProviders()
    if (rows.length === 0) {
      hiveOutro("Sin providers configurados", "error"); return
    }
    const sel = await hiveSelect({
      message: "Provider a editar:",
      options: rows.map((r) => ({ value: r.id, label: r.id })),
    })
    if (isCancel(sel)) { hiveOutro("Cancelado", "error"); return }
    providerId = sel as string
  }

  const row = await getProvider(providerId)
  if (!row) {
    hiveOutro(`Provider no encontrado: ${providerId}`, "error")
    process.exit(1)
  }

  const currentModel = await getProviderModel(providerId)

  if (providerId === "hiveagents") {
    hiveNote("Preset fijo", [
      `Base URL: ${HIVEAGENTS_OPENAI_BASE_URL}`,
      `Modelo:   ${HIVEAGENTS_MODEL_ID}`,
      "Solo necesitas actualizar la API key.",
    ])
    const apiKey = await hiveText({
      message: "Nueva API key (Enter para mantener):",
      placeholder: "HiveAgents API key",
      password: true,
    })
    await upsertProvider(providerId, {
      baseUrl: HIVEAGENTS_OPENAI_BASE_URL,
      enabled: true,
    })
    await setProviderModel(providerId, HIVEAGENTS_MODEL_ID)
    if (!isCancel(apiKey) && apiKey && typeof apiKey === "string") {
      await storeProviderApiKey(providerId, apiKey)
      await maybePreloadHiveAgents(providerId, HIVEAGENTS_MODEL_ID)
    }
    hiveOutro("HiveAgents actualizado")
    return
  }

  hiveNote("Valores actuales", [
    `ID:       ${row.id}`,
    `Base URL: ${row.base_url ?? "—"}`,
    `Modelo:   ${currentModel || "default"}`,
    "(Enter en blanco mantiene el valor actual)",
  ])

  // ── API Key ─────────────────────────────────────────────────────────────────
  const apiKey = await hiveText({
    message: "Nueva API key (Enter para mantener):",
    placeholder: "sk-...",
  })

  // ── Base URL ─────────────────────────────────────────────────────────────────
  const baseUrl = await hiveText({
    message: "Nueva Base URL (Enter para mantener):",
    placeholder: row.base_url ?? "https://api...",
  })

  // ── Modelo ───────────────────────────────────────────────────────────────────
  let model = currentModel
  const dbModels = await listModelChoices(providerId)

  if (dbModels.length > 0) {
    const opts = [
      { value: "__keep__", label: `Mantener actual (${currentModel || "default"})` },
      ...dbModels,
      { value: "__custom__", label: "Escribir manualmente" },
    ]
    const sel = await hiveSelect({ message: "Modelo:", options: opts })
    if (isCancel(sel)) { hiveOutro("Cancelado", "error"); return }
    if (sel === "__custom__") {
      const custom = await hiveText({ message: "Nombre del modelo:", placeholder: "claude-sonnet-4-6..." })
      if (!isCancel(custom) && custom && typeof custom === "string") model = custom
    } else if (sel !== "__keep__") {
      model = sel as string
    }
  } else {
    const inp = await hiveText({
      message: `Modelo (actual: ${currentModel || "default"}, Enter para mantener):`,
      placeholder: currentModel || "ej: gpt-4o, llama3-70b...",
    })
    if (!isCancel(inp) && inp && typeof inp === "string") model = inp
  }

  // ── Aplicar cambios ──────────────────────────────────────────────────────────
  if (!isCancel(baseUrl) && baseUrl && typeof baseUrl === "string") {
    await upsertProvider(providerId, { baseUrl })
  }

  await setProviderModel(providerId, model)

  if (!isCancel(apiKey) && apiKey && typeof apiKey === "string") {
    await storeProviderApiKey(providerId, apiKey)
  }

  await maybePreloadHiveAgents(providerId, model)

  hiveOutro(`Provider ${providerId} actualizado`)
}

export async function providerSetDefault(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode provider set-default <name>", "error")
    process.exit(1)
  }

  const row = await getProvider(name)

  if (!row) {
    hiveOutro(`Provider no encontrado: ${name}`, "error")
    process.exit(1)
  }

  await setDefaultProvider(name)
  hiveOutro(`${name} es ahora el provider por defecto`)
}

export async function providerSetModel(args: string[]): Promise<void> {

  const providerId = args[0]
  const model = args[1]

  if (!providerId || !model) {
    hiveOutro("Uso: hivecode provider set-model <provider> <model>", "error")
    process.exit(1)
  }

  if (providerId === "hiveagents" && model !== HIVEAGENTS_MODEL_ID) {
    hiveOutro(`HiveAgents solo admite ${HIVEAGENTS_MODEL_ID}`, "error")
    process.exit(1)
  }

  await setProviderModel(providerId, model)
  await maybePreloadHiveAgents(providerId, model)
  hiveOutro(`Modelo ${model} asignado a ${providerId}`)
}

export async function providerTest(name?: string): Promise<void> {
  hiveIntro("hivecode · Test Provider")

  const providerId = name ?? await hiveText({
    message: "Provider a probar:",
    placeholder: "anthropic, openai...",
  })

  if (isCancel(providerId) || !providerId || typeof providerId !== "string") {
    hiveOutro("Cancelado", "error")
    return
  }

  const row = await getProvider(providerId)
  if (!row) {
    hiveOutro(`Provider no encontrado: ${providerId}`, "error")
    process.exit(1)
  }

  const spinner = hiveSpinner("default")
  spinner.start(`Probando ${providerId}...`)

  try {
    const start = performance.now()

    const baseUrl = row.base_url || "https://api.anthropic.com"
    const apiKey = await getProviderApiKey(providerId)
    const modelsUrl = `${baseUrl.replace(/\/+$/, "")}${baseUrl.endsWith("/v1") ? "" : "/v1"}/models`
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const latency = Math.round(performance.now() - start)

    spinner.stop(`${providerId} responde en ${latency}ms`)
    hiveOutro(`${providerId} OK · ${latency}ms`)
  } catch (err) {
    spinner.stop(`Error: ${(err as Error).message}`, "error")
    hiveOutro(`${providerId} no responde`, "error")
    process.exit(1)
  }
}
