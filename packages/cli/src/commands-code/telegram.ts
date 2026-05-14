/**
 * Telegram channel commands — connect/disconnect/status.
 *
 * hivecode telegram connect
 * hivecode telegram disconnect
 * hivecode telegram status
 */

import {
  hiveIntro,
  hiveOutro,
  hivePhaseComplete,
  hiveNote,
  hiveSpinner,
  runTelegramConnectWizard,
} from "@johpaz/hivecode-ui"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

export async function telegramConnect(): Promise<void> {
  hiveIntro("hivecode · Conectar Telegram")

  const result = await runTelegramConnectWizard()
  if (!result) {
    hiveOutro("Cancelado", "error")
    return
  }

  const db = getDb()
  const configJson = JSON.stringify({
    dmPolicy: result.dmPolicy,
    allowFrom: result.allowFrom,
    groups: result.groups,
    enabled: true,
  })

  db.query(`
    INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status)
    VALUES ('telegram', 'telegram', ?, 1, 'connected')
  `).run(Buffer.from(configJson).toString("base64"))

  try {
    const secrets = (Bun as any).secrets
    if (secrets?.set) secrets.set("TELEGRAM_BOT_TOKEN", result.botToken)
  } catch {
    // Token no se puede guardar en Bun.secrets — ya está en la config
  }

  hivePhaseComplete("telegram", "Bot de Telegram configurado")
  hiveNote("Próximos pasos", [
    "Token guardado en secretos del sistema.",
    `DM policy: ${result.dmPolicy}`,
    result.allowFrom.length ? `Lista blanca: ${result.allowFrom.join(", ")}` : "",
    result.groups ? "Grupos: habilitados" : "Grupos: deshabilitados",
    "Reinicia el gateway para activar: hivecode dev",
  ].filter(Boolean))
  hiveOutro("Telegram conectado")
}

export async function telegramEdit(): Promise<void> {
  hiveIntro("hivecode · Editar Telegram")

  const db = getDb()
  const row = db.query("SELECT * FROM channels WHERE id = 'telegram'").get() as any
  if (!row) {
    hiveNote("Telegram no configurado", ["No hay configuración previa.", "Usa: hivecode telegram connect"])
    hiveOutro("Sin configuración existente", "error")
    return
  }

  let existingConfig: Record<string, any> = {}
  try { existingConfig = JSON.parse(Buffer.from(row.config_encrypted as string, "base64").toString()) } catch {}

  hiveNote("Configuración actual", [
    `DM Policy:   ${existingConfig.dmPolicy ?? "—"}`,
    `Grupos:      ${existingConfig.groups ? "sí" : "no"}`,
    existingConfig.allowFrom?.length
      ? `Lista blanca: ${(existingConfig.allowFrom as string[]).join(", ")}`
      : "Lista blanca: —",
    "(El wizard pedirá los nuevos valores)",
  ])

  const result = await runTelegramConnectWizard()
  if (!result) {
    hiveOutro("Cancelado", "error")
    return
  }

  const configJson = JSON.stringify({
    dmPolicy: result.dmPolicy,
    allowFrom: result.allowFrom,
    groups: result.groups,
    enabled: true,
  })

  db.query(`
    UPDATE channels SET config_encrypted = ?, enabled = 1, status = 'connected'
    WHERE id = 'telegram'
  `).run(Buffer.from(configJson).toString("base64"))

  try {
    const secrets = (Bun as any).secrets
    if (secrets?.set) secrets.set("TELEGRAM_BOT_TOKEN", result.botToken)
  } catch {}

  hivePhaseComplete("telegram", "Configuración de Telegram actualizada")
  hiveOutro("Telegram actualizado")
}

export async function telegramDisconnect(): Promise<void> {
  hiveIntro("hivecode · Desconectar Telegram")
  const db = getDb()

  const row = db.query("SELECT id FROM channels WHERE id = 'telegram'").get() as any
  if (!row) {
    hiveOutro("Telegram no estaba configurado")
    return
  }

  db.query("UPDATE channels SET enabled = 0, status = 'disconnected' WHERE id = 'telegram'").run()
  try {
    const s = (Bun as any).secrets
    if (s?.delete) s.delete("TELEGRAM_BOT_TOKEN")
  } catch {}

  hiveOutro("Telegram desconectado")
}

export async function telegramStatus(): Promise<void> {
  hiveIntro("hivecode · Estado Telegram")
  const db = getDb()
  const row = db.query("SELECT * FROM channels WHERE id = 'telegram'").get() as any

  if (!row) {
    hiveNote("Telegram no configurado", ["Ejecuta: hivecode telegram connect"])
    hiveOutro("Sin configuración", "error")
    return
  }

  let config: Record<string, any> = {}
  try {
    config = JSON.parse(Buffer.from(row.config_encrypted as string, "base64").toString())
  } catch {}

  hivePhaseComplete("telegram", `Estado: ${row.status ?? "desconocido"}`)
  hiveNote("Configuración", [
    `Activo:      ${row.enabled ? "sí" : "no"}`,
    `DM Policy:   ${config.dmPolicy ?? "—"}`,
    `Grupos:      ${config.groups ? "sí" : "no"}`,
    config.allowFrom?.length
      ? `Lista blanca: ${(config.allowFrom as string[]).join(", ")}`
      : "Lista blanca: —",
  ])

  let token: string | undefined
  try { token = (Bun as any).secrets?.["TELEGRAM_BOT_TOKEN"] } catch {}

  if (token) {
    const spinner = hiveSpinner("default")
    spinner.start("Verificando token con Telegram API...")
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
      const data = await res.json() as any
      if (data.ok) {
        spinner.stop(`Bot verificado: @${data.result.username}`)
      } else {
        spinner.stop(`Token inválido o expirado`, "error")
      }
    } catch (e) {
      spinner.stop(`Error de red: ${(e as Error).message}`, "error")
    }
  } else {
    hiveNote("Token", ["No hay token guardado en secretos del sistema."])
  }

  hiveOutro("Estado mostrado")
}
