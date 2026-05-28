/**
 * Onboarding wizard — first-time setup for hivecode.
 *
 * hivecode onboard
 */

import {
  hiveIntro, hiveOutro, hiveNote, isCancel,
  runProviderSetupWizard,
} from "@johpaz/hivecode-tui-primitives"

import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { storeProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"

const VERSION = "1.0.0"

export async function onboard(version = VERSION): Promise<void> {
  hiveIntro(`hivecode  v${version}`)

  const db = getDb()

  // Check existing providers
  const existing = (
    db.query("SELECT id FROM providers ORDER BY id").all() as { id: string }[]
  ).map((r) => r.id)

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

  // Upsert provider
  db.query(`
    INSERT INTO providers (id, name, base_url, enabled)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      base_url = excluded.base_url,
      enabled = 1
  `).run(
    result.provider,
    result.provider,
    result.baseUrl || null,
  )

  // Set as default
  db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_provider', ?)")
    .run(result.provider)

  if (result.model) {
    db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)")
      .run(`provider_model_${result.provider}`, result.model)
  }

  // Update coordinator agents to use this provider/model
  const agentModelId = result.model
    ? (db.query("SELECT 1 FROM models WHERE id = ?").get(result.model) ? result.model : null)
    : null

  db.query(`
    UPDATE agents SET provider_id = ?, model_id = ?
    WHERE role = 'coordinator'
  `).run(result.provider, agentModelId)

  hiveOutro(`Onboarding completo · Provider ${result.provider} configurado`)
}
