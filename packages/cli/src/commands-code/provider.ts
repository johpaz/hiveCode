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
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { deleteProviderApiKey, storeProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"

function modelsForProvider(providerId: string): { value: string; label: string }[] {
  try {
    return (getDb()
      .query("SELECT id, name FROM models WHERE provider_id = ? AND model_type = 'llm' ORDER BY name")
      .all(providerId) as { id: string; name: string }[])
      .map((r) => ({ value: r.id, label: r.name }))
  } catch { return [] }
}

export async function providerList(): Promise<void> {
  const db = getDb()
  const rows = db.query("SELECT id, name, base_url, enabled FROM providers ORDER BY id").all() as any[]

  hiveIntro("hivecode · Providers")

  if (rows.length === 0) {
    hiveNote("Sin providers", ["No hay providers configurados.", "Usa: hivecode provider add <name>"])
    hiveOutro("Sin providers")
    return
  }

  const defaultProvider = (db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get() as any)?.value ?? ""
  const modelRows = db.query("SELECT key, value FROM code_config WHERE key LIKE 'provider_model_%'").all() as any[]
  const modelMap = new Map(modelRows.map((r: any) => [r.key.replace("provider_model_", ""), r.value]))

  const lines = rows.map((r: any) => {
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
      options: rows.map((r: any) => ({
        value: r.id,
        label: `${r.id}${defaultProvider === r.id ? " (actual)" : ""}`,
      })),
    })
    if (!isCancel(sel)) {
      db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_provider', ?)").run(sel)
      hiveOutro(`${sel} es ahora el provider por defecto`)
    }
    return
  }

  if (action === "delete") {
    const sel = await hiveSelect({
      message: "Provider a eliminar:",
      options: rows.map((r: any) => ({ value: r.id, label: r.id })),
    })
    if (!isCancel(sel)) {
      await deleteProviderApiKey(sel as string)
      db.query("DELETE FROM providers WHERE id = ?").run(sel as string)
      hiveOutro(`Provider ${sel} eliminado`)
    }
    return
  }

  if (action === "add") {
    const known = rows.map((r: any) => r.id as string)
    const result = await runProviderSetupWizard(known, VERSION)
    if (!result) { hiveOutro("Cancelado", "error"); return }
    await storeProviderApiKey(result.provider, result.apiKey)
    db.query(`
      INSERT INTO providers (id, name, base_url, enabled)
      VALUES (?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        enabled  = 1
    `).run(result.provider, result.provider, result.baseUrl || null)
    if (result.model) {
      db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?,?)")
        .run(`provider_model_${result.provider}`, result.model)
    }
    hiveOutro(`Provider ${result.provider} agregado`)
  }
}

export async function providerAdd(name?: string): Promise<void> {
  const db = getDb()
  const knownProviders = (
    db.query("SELECT id FROM providers ORDER BY id").all() as { id: string }[]
  ).map((r) => r.id)

  const result = await runProviderSetupWizard(knownProviders, VERSION)
  if (!result) return

  const existing = db.query("SELECT id FROM providers WHERE id = ?").get(result.provider) as any
  if (existing) {
    hiveNote("Provider existente", [`${result.provider} ya existe. Usa 'provider edit' para modificarlo.`])
    hiveOutro("No se añadió", "error")
    return
  }

  await storeProviderApiKey(result.provider, result.apiKey)
  db.query("INSERT INTO providers (id, name, base_url, enabled) VALUES (?, ?, ?, 1)")
    .run(result.provider, result.provider, result.baseUrl || null)

  if (result.model) {
    db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)")
      .run(`provider_model_${result.provider}`, result.model)
  }

}

export async function providerRemove(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode provider remove <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  const row = db.query("SELECT id, name FROM providers WHERE id = ?").get(name) as any

  if (!row) {
    hiveOutro(`Provider no encontrado: ${name}`, "error")
    process.exit(1)
  }

  await deleteProviderApiKey(name)
  db.query("DELETE FROM providers WHERE id = ?").run(name)
  hiveOutro(`Provider ${name} eliminado`)
}

export async function providerEdit(name?: string): Promise<void> {
  hiveIntro("hivecode · Editar Provider")

  const db = getDb()

  let providerId = name
  if (!providerId) {
    const rows = db.query("SELECT id FROM providers ORDER BY id").all() as { id: string }[]
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

  const row = db.query("SELECT id, name, base_url FROM providers WHERE id = ?").get(providerId) as any
  if (!row) {
    hiveOutro(`Provider no encontrado: ${providerId}`, "error")
    process.exit(1)
  }

  const currentModel = (
    db.query("SELECT value FROM code_config WHERE key = ?").get(`provider_model_${providerId}`) as any
  )?.value ?? ""

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
  const dbModels = modelsForProvider(providerId)

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
    db.query("UPDATE providers SET base_url = ? WHERE id = ?").run(baseUrl, providerId)
  }

  db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)").run(
    `provider_model_${providerId}`, model,
  )

  if (!isCancel(apiKey) && apiKey && typeof apiKey === "string") {
    await storeProviderApiKey(providerId, apiKey)
  }

  hiveOutro(`Provider ${providerId} actualizado`)
}

export async function providerSetDefault(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode provider set-default <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  const row = db.query("SELECT id FROM providers WHERE id = ?").get(name) as any

  if (!row) {
    hiveOutro(`Provider no encontrado: ${name}`, "error")
    process.exit(1)
  }

  db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_provider', ?)").run(name)
  hiveOutro(`${name} es ahora el provider por defecto`)
}

export async function providerSetModel(args: string[]): Promise<void> {

  const providerId = args[0]
  const model = args[1]

  if (!providerId || !model) {
    hiveOutro("Uso: hivecode provider set-model <provider> <model>", "error")
    process.exit(1)
  }

  const db = getDb()
  db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)")
    .run(`provider_model_${providerId}`, model)
  hiveOutro(`Modelo ${model} asignado a ${providerId}`)
}

export async function providerTest(name?: string): Promise<void> {
  hiveIntro("hivecode · Test Provider")

  const db = getDb()
  const providerId = name ?? await hiveText({
    message: "Provider a probar:",
    placeholder: "anthropic, openai...",
  })

  if (isCancel(providerId) || !providerId || typeof providerId !== "string") {
    hiveOutro("Cancelado", "error")
    return
  }

  const row = db.query("SELECT id, name, base_url FROM providers WHERE id = ?").get(providerId) as any
  if (!row) {
    hiveOutro(`Provider no encontrado: ${providerId}`, "error")
    process.exit(1)
  }

  const spinner = hiveSpinner("default")
  spinner.start(`Probando ${providerId}...`)

  try {
    const start = performance.now()

    // Try a simple ping — fetch the base URL or a known endpoint
    const baseUrl = row.base_url || "https://api.anthropic.com"
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    })
    const latency = Math.round(performance.now() - start)

    spinner.stop(`${providerId} responde en ${latency}ms`)
    hiveOutro(`${providerId} OK · ${latency}ms`)
  } catch (err) {
    spinner.stop(`Error: ${(err as Error).message}`, "error")
    hiveOutro(`${providerId} no responde`, "error")
    process.exit(1)
  }
}
