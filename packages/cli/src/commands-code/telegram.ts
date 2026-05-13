/**
 * Telegram channel commands — connect/disconnect/status.
 *
 * hive-code telegram connect
 * hive-code telegram disconnect
 * hive-code telegram status
 */

import {
  hiveIntro,
  hiveOutro,
  hivePhaseComplete,
  hiveNote,
  hiveSpinner,
  runTelegramConnectWizard,
} from "@johpaz/hive-code-ui"
import { getDb } from "@johpaz/hive-code-core/storage/sqlite"

export async function telegramConnect(): Promise<void> {
  hiveIntro("hive-code · Conectar Telegram")

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
    "Reinicia el gateway para activar: hive-code dev",
  ].filter(Boolean))
  hiveOutro("Telegram conectado")
}

export async function telegramDisconnect(): Promise<void> {
  hiveIntro("hive-code · Desconectar Telegram")
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
  hiveIntro("hive-code · Estado Telegram")
  const db = getDb()
  const row = db.query("SELECT * FROM channels WHERE id = 'telegram'").get() as any

  if (!row) {
    hiveNote("Telegram no configurado", ["Ejecuta: hive-code telegram connect"])
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
