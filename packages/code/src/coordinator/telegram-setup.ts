/**
 * Checks done before Telegram's settings are saved. A token that was never tried and a whitelist that
 * can never match both end with a bot that reads "connected" and answers nobody.
 */

export type TokenCheck = { ok: true; username: string } | { ok: false; error: string }

/** Asks Telegram who the token belongs to (`getMe`). Nothing is saved or started before this answers. */
export async function verifyTelegramToken(
  token: string,
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }> = fetch as any,
  timeoutMs = 8_000,
): Promise<TokenCheck> {
  const clean = token.trim()
  if (!/^\d{5,}:[\w-]{30,}$/.test(clean)) {
    return { ok: false, error: "El token no tiene el formato de BotFather (123456789:ABC-DEF…)." }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${clean}/getMe`, { signal: controller.signal })
    const body = await response.json().catch(() => null)
    if (response.ok && body?.ok && body.result?.username) return { ok: true, username: String(body.result.username) }
    if (response.status === 401 || response.status === 404) return { ok: false, error: "Telegram rechazó el token (revócalo y pide uno nuevo en @BotFather si ya no es válido)." }
    return { ok: false, error: `Telegram respondió ${response.status}: ${String(body?.description ?? "sin detalle")}` }
  } catch (error) {
    const aborted = (error as Error).name === "AbortError"
    return { ok: false, error: aborted ? "Telegram no respondió a tiempo: no pude comprobar el token." : `No pude comprobar el token con Telegram (${(error as Error).message}).` }
  } finally {
    clearTimeout(timer)
  }
}

export type AllowFromCheck = { ok: true; allowFrom: string[] } | { ok: false; error: string }

/**
 * The bot recognises people by their numeric Telegram id (`/myid` shows it), not by @username, so a
 * whitelist of usernames would silently lock everybody out. Accepts `123`, `tg:123`.
 */
export function normalizeAllowFrom(raw: string | undefined, dmPolicy: string): AllowFromCheck {
  const entries = (raw ?? "").split(/[,\s]+/).map(entry => entry.trim()).filter(Boolean)
  const ids: string[] = []
  for (const entry of entries) {
    const id = /^(?:tg:)?(-?\d{3,})$/.exec(entry)?.[1]
    if (!id) {
      return { ok: false, error: `"${entry}" no es un ID numérico. El bot reconoce a las personas por su ID de Telegram: pídele /myid al bot y pega ese número.` }
    }
    ids.push(id)
  }
  if (dmPolicy === "allowlist" && ids.length === 0) {
    return { ok: false, error: "Con la política allowlist hace falta al menos un ID en la lista blanca (envía /myid al bot para obtener el tuyo)." }
  }
  return { ok: true, allowFrom: [...new Set(ids)] }
}
