import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { hiveOutro, hiveText, hiveSelect, isCancel, C, S } from "../theme.ts"
import { BEE } from "../mascot.ts"

export interface ProviderSetupResult {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
}

function getModelsForProvider(providerId: string): { value: string; label: string }[] {
  try {
    const rows = getDb()
      .query(
        "SELECT id, name FROM models WHERE provider_id = ? AND model_type = 'llm' ORDER BY name",
      )
      .all(providerId) as { id: string; name: string }[]
    return rows.map((r) => ({ value: r.id, label: r.name }))
  } catch {
    return []
  }
}

function showWelcome(version: string): void {
  const bee   = BEE.happy
  const title = `hivecode  ${C.dim}v${version}${C.reset}`
  const sub   = "Configura tu provider LLM para comenzar"
  process.stdout.write(`\n`)
  process.stdout.write(` ${C.amber}╔══════════════════════════════════════════╗${C.reset}\n`)
  process.stdout.write(` ${C.amber}║${C.reset}  ${C.amber}${bee}${C.reset}  ${C.bold}${C.amber}${title}${C.reset}                ${C.amber}║${C.reset}\n`)
  process.stdout.write(` ${C.amber}║${C.reset}  ${C.dim}${sub}${C.reset}   ${C.amber}║${C.reset}\n`)
  process.stdout.write(` ${C.amber}╚══════════════════════════════════════════╝${C.reset}\n\n`)
}

export async function runProviderSetupWizard(
  knownProviders: string[] = [],
  version = "1.0.0",
): Promise<ProviderSetupResult | null> {
  showWelcome(version)

  // ── Seleccionar o escribir el nombre del provider ─────────────────────────
  let provider = ""
  if (knownProviders.length > 0) {
    const sel = await hiveSelect({
      message: "Provider:",
      options: knownProviders.map((p) => ({ value: p, label: p })),
    })
    if (isCancel(sel)) { hiveOutro("Cancelado", "error"); return null }
    provider = sel as string
  } else {
    const inp = await hiveText({
      message: "Nombre del provider:",
      placeholder: "anthropic, openai, groq...",
    })
    if (isCancel(inp) || !inp || typeof inp !== "string") {
      hiveOutro("Cancelado", "error"); return null
    }
    provider = inp
  }

  // ── API Key ───────────────────────────────────────────────────────────────
  const apiKey = await hiveText({
    message: `API Key para ${provider}:`,
    placeholder: "sk-...",
    password: true,
    validate: (v) => !v.trim() ? "La API key no puede estar vacía" : undefined,
  })
  if (isCancel(apiKey)) { hiveOutro("Cancelado", "error"); return null }

  // ── Base URL (opcional) ───────────────────────────────────────────────────
  const baseUrl = await hiveText({
    message: "Base URL (opcional):",
    placeholder: "https://api.anthropic.com",
  })

  // ── Modelo: seleccionar de la DB o escribir uno personalizado ─────────────
  let model = ""
  const dbModels = getModelsForProvider(provider)

  if (dbModels.length > 0) {
    const modelOptions = [
      ...dbModels,
      { value: "__custom__", label: "Otro (escribir manualmente)" },
    ]
    const sel = await hiveSelect({
      message: `Modelo para ${provider}:`,
      options: modelOptions,
    })
    if (isCancel(sel)) { hiveOutro("Cancelado", "error"); return null }

    if (sel === "__custom__") {
      const custom = await hiveText({
        message: "Nombre del modelo:",
        placeholder: "ej: claude-sonnet-4-6, gpt-4o...",
      })
      if (!isCancel(custom) && custom && typeof custom === "string") model = custom
    } else {
      model = sel as string
    }
  } else {
    // Provider sin modelos en DB — campo libre
    const inp = await hiveText({
      message: "Modelo por defecto (opcional):",
      placeholder: "ej: claude-sonnet-4-6, gpt-4o, llama3-70b...",
    })
    if (!isCancel(inp) && inp && typeof inp === "string") model = inp
  }

  hiveOutro(`Provider ${provider} configurado`)
  return {
    provider,
    apiKey,
    baseUrl: (!isCancel(baseUrl) && baseUrl && typeof baseUrl === "string") ? baseUrl : "",
    model,
  }
}
