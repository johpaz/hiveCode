/**
 * channel-notify — singleton para que tools envíen mensajes al canal activo del usuario.
 *
 * Se inicializa en server.ts con el channelManager real.
 * Las tools (notify, report_progress) lo importan directamente.
 */

import { logger } from "../utils/logger"
import { col } from "../storage/hive"
import type { UserIdentityDoc } from "../storage/collections"

const log = logger.child("channel-notify")

type SendFn = (channel: string, sessionId: string, message: string) => Promise<void>

let _sendFn: SendFn | null = null
/**
 * La TUI como destino.
 *
 * Escribir por la TUI **es** hablar con un canal: es donde esta el usuario. Sin
 * este sink, `report_progress` caia a su default (`"webchat"`), que no existe,
 * y el modelo reintentaba en bucle. Antes de que exista un canal web real, el
 * reporte tenia que llegar a la pantalla.
 */
let _tuiSendFn: ((message: string) => void) | null = null

/** Llamar en server.ts una vez que channelManager esté listo */
export function setChannelSendFn(fn: SendFn): void {
  _sendFn = fn
  log.info("[channel-notify] Send function registered")
}

/** Llamar desde el launcher de la TUI, con el envio al socket ya disponible. */
export function setTuiSendFn(fn: (message: string) => void): void {
  _tuiSendFn = fn
  log.info("[channel-notify] TUI sink registered")
}

/**
 * Resuelve el sessionId real (chat ID de Telegram, etc.) desde user_identities.
 * Necesario porque config.thread_id es el userId interno, no el chat ID externo.
 */
async function resolveSessionId(userId: string, channel: string): Promise<string> {
  try {
    const identity = (await (await col<UserIdentityDoc>("userIdentities")).findBy("user_id", userId))
      .map((entry) => entry.doc)
      .find((entry) => entry.channel === channel)
    if (identity?.channel_user_id) return identity.channel_user_id
  } catch {
    // Store unavailable: fallback to userId.
  }
  return userId
}

/**
 * Envía un mensaje al canal activo del usuario.
 * Usado por las tools notify y report_progress.
 */
export async function sendToUserChannel(
  channel: string,
  userId: string,
  message: string
): Promise<{ ok: boolean; error?: string; delivered_to?: string }> {
  // El gateway no está arrancado (sesión puramente TUI). La pantalla es el
  // destino correcto, no un destino de reserva.
  if (!_sendFn) {
    if (_tuiSendFn) {
      try {
        _tuiSendFn(message)
        return { ok: true, delivered_to: "tui" as const }
      } catch (err) {
        log.warn(`[channel-notify] TUI send failed: ${(err as Error).message}`)
        return { ok: false, error: (err as Error).message }
      }
    }
    log.warn("[channel-notify] No send function registered — message dropped")
    return { ok: false, error: "Channel send not initialized" }
  }

  // «tui» no es un canal del gateway: es la propia pantalla. Buscarlo en el
  // gateway fallaba siempre y dejaba un WARN en cada aviso.
  if (channel === "tui" && _tuiSendFn) {
    try {
      _tuiSendFn(message)
      return { ok: true, delivered_to: "tui" as const }
    } catch (err) {
      log.warn(`[channel-notify] TUI send failed: ${(err as Error).message}`)
      return { ok: false, error: (err as Error).message }
    }
  }

  const sessionId = await resolveSessionId(userId, channel)
  log.info(`[channel-notify] Sending to ${channel}/${sessionId}: ${message.substring(0, 80)}`)

  try {
    await _sendFn(channel, sessionId, message)
    return { ok: true, delivered_to: channel }
  } catch (err) {
    // El canal no existe o está caído. Si hay una TUI conectada, el mensaje
    // sigue llegando: perder un reporte es peor que entregarlo donde el
    // usuario puede verlo.
    const motivo = (err as Error).message
    if (_tuiSendFn) {
      try {
        _tuiSendFn(message)
        log.warn(`[channel-notify] canal «${channel}» no disponible (${motivo}) — entregado a la TUI`)
        return { ok: true, delivered_to: "tui" as const }
      } catch {
        // cae al error de abajo
      }
    }
    log.warn(`[channel-notify] Failed to send: ${motivo}`)
    return { ok: false, error: motivo }
  }
}
