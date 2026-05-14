import { hiveIntro, hiveOutro, hiveText, hiveSelect, hiveConfirm, isCancel } from "../theme.ts"

export interface TelegramSetupResult {
  botToken: string
  dmPolicy: "open" | "allowlist"
  groups: boolean
  allowFrom: string[]
}

export async function runTelegramConnectWizard(): Promise<TelegramSetupResult | null> {
  hiveIntro("hivecode · Conectar Telegram")

  // ── Bot Token ─────────────────────────────────────────────────────────────
  const botToken = await hiveText({
    message: "Bot Token (de @BotFather en Telegram):",
    placeholder: "123456789:AAF...",
  })
  if (isCancel(botToken) || !botToken || typeof botToken !== "string") {
    hiveOutro("Cancelado", "error"); return null
  }

  // ── Política de mensajes directos ─────────────────────────────────────────
  const dmPolicyRaw = await hiveSelect({
    message: "Política de mensajes directos:",
    options: [
      { value: "open",      label: "Abierto — cualquiera puede escribirle al bot" },
      { value: "allowlist", label: "Lista blanca — solo IDs permitidos" },
    ],
  })
  if (isCancel(dmPolicyRaw)) { hiveOutro("Cancelado", "error"); return null }
  const dmPolicy = dmPolicyRaw as "open" | "allowlist"

  // ── IDs permitidos (solo si allowlist) ────────────────────────────────────
  let allowFrom: string[] = []
  if (dmPolicyRaw === "allowlist") {
    const ids = await hiveText({
      message: "IDs permitidos (separados por coma):",
      placeholder: "tg:123456,tg:789012",
    })
    if (isCancel(ids)) { hiveOutro("Cancelado", "error"); return null }
    allowFrom = ids && typeof ids === "string"
      ? ids.split(",").map((x) => x.trim()).filter(Boolean)
      : []
  }

  // ── Soporte de grupos ─────────────────────────────────────────────────────
  const groups = await hiveConfirm({
    message: "¿Habilitar soporte de grupos de Telegram?",
    initialValue: false,
  })
  if (isCancel(groups)) { hiveOutro("Cancelado", "error"); return null }

  hiveOutro("Telegram conectado")
  return { botToken, dmPolicy, groups: groups as boolean, allowFrom }
}
