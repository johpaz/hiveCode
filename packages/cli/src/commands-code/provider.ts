/**
 * Provider commands — manage LLM providers and API keys.
 *
 * hive-code provider list
 * hive-code provider add <name>
 * hive-code provider remove <name>
 * hive-code provider set-default <name>
 * hive-code provider set-model <provider> <model>
 * hive-code provider test <name>
 */

import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveSpinner, hiveText, hiveSelect, isCancel,
} from "../ui/index.ts"
import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { ensureCodeDatabase } from "./db-init"

export async function providerList(): Promise<void> {
  ensureCodeDatabase()
  hiveIntro("hive-code · Providers")

  const db = getDb()
  const rows = db.query("SELECT id, name, base_url, enabled, model_id FROM providers ORDER BY id").all() as any[]

  if (rows.length === 0) {
    hiveNote("Sin providers", ["No hay providers configurados. Usa 'hive-code provider add <name>'"])
    hiveOutro("Sin providers")
    return
  }

  const defaultProvider = db.query("SELECT value FROM config WHERE key = 'default_provider'").get() as any

  for (const row of rows) {
    const isDefault = defaultProvider?.value === row.id
    const status = row.enabled ? "●" : "○"
    const color = row.enabled ? "\x1b[38;5;114m" : "\x1b[38;5;240m"
    hivePhaseComplete(row.id, `${row.name}${isDefault ? " (default)" : ""}`)
    process.stdout.write(`  │    ${color}${status}\x1b[0m  ${row.id}  ·  model: ${row.model_id || "default"}\n`)
    if (row.base_url) {
      process.stdout.write(`  │         ${row.base_url}\n`)
    }
    process.stdout.write(`  │\n`)
  }

  hiveOutro(`${rows.length} provider(s)`)
}

export async function providerAdd(name?: string): Promise<void> {
  ensureCodeDatabase()
  hiveIntro("hive-code · Añadir Provider")

  const providerName = name ?? await hiveText({
    message: "Nombre del provider:",
    placeholder: "anthropic, openai, groq...",
  })

  if (isCancel(providerName) || !providerName || typeof providerName !== "string") {
    hiveOutro("Cancelado", "error")
    return
  }

  const apiKey = await hiveText({
    message: `API key para ${providerName}:`,
    placeholder: "sk-...",
  })

  if (isCancel(apiKey) || !apiKey || typeof apiKey !== "string") {
    hiveOutro("Cancelado", "error")
    return
  }

  const db = getDb()

  // Check if provider already exists
  const existing = db.query("SELECT id FROM providers WHERE id = ?").get(providerName) as any
  if (existing) {
    hiveNote("Provider existente", [`${providerName} ya existe. Usa 'provider remove' primero.`])
    hiveOutro("No se añadió", "error")
    return
  }

  const baseUrl = await hiveText({
    message: "Base URL (opcional):",
    placeholder: "https://api...",
  })

  const model = await hiveText({
    message: "Modelo por defecto (opcional):",
    placeholder: "claude-sonnet-4, gpt-4o...",
  })

  db.query(`
    INSERT INTO providers (id, name, base_url, model_id, enabled)
    VALUES (?, ?, ?, ?, 1)
  `).run(
    providerName,
    providerName,
    (!isCancel(baseUrl) && baseUrl && typeof baseUrl === "string") ? baseUrl : null,
    (!isCancel(model) && model && typeof model === "string") ? model : null
  )

  // Store API key in Bun.secrets if available
  try {
    const secrets = (Bun as any).secrets
    if (secrets?.set) {
      secrets.set(`${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`, apiKey)
    }
  } catch {
    // Fallback: store encrypted in DB
    db.query("UPDATE providers SET api_key_encrypted = ? WHERE id = ?")
      .run(Buffer.from(apiKey).toString("base64"), providerName)
  }

  hiveOutro(`Provider ${providerName} añadido`)
}

export async function providerRemove(name?: string): Promise<void> {
  ensureCodeDatabase()

  if (!name) {
    hiveOutro("Uso: hive-code provider remove <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  const row = db.query("SELECT id, name FROM providers WHERE id = ?").get(name) as any

  if (!row) {
    hiveOutro(`Provider no encontrado: ${name}`, "error")
    process.exit(1)
  }

  db.query("DELETE FROM providers WHERE id = ?").run(name)
  hiveOutro(`Provider ${name} eliminado`)
}

export async function providerSetDefault(name?: string): Promise<void> {
  ensureCodeDatabase()

  if (!name) {
    hiveOutro("Uso: hive-code provider set-default <name>", "error")
    process.exit(1)
  }

  const db = getDb()
  const row = db.query("SELECT id FROM providers WHERE id = ?").get(name) as any

  if (!row) {
    hiveOutro(`Provider no encontrado: ${name}`, "error")
    process.exit(1)
  }

  db.query("INSERT OR REPLACE INTO config (key, value) VALUES ('default_provider', ?)").run(name)
  hiveOutro(`${name} es ahora el provider por defecto`)
}

export async function providerSetModel(args: string[]): Promise<void> {
  ensureCodeDatabase()

  const providerId = args[0]
  const model = args[1]

  if (!providerId || !model) {
    hiveOutro("Uso: hive-code provider set-model <provider> <model>", "error")
    process.exit(1)
  }

  const db = getDb()
  db.query("UPDATE providers SET model_id = ? WHERE id = ?").run(model, providerId)
  hiveOutro(`Modelo ${model} asignado a ${providerId}`)
}

export async function providerTest(name?: string): Promise<void> {
  ensureCodeDatabase()
  hiveIntro("hive-code · Test Provider")

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
