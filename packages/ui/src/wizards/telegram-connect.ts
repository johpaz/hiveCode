import { ui } from "@rezi-ui/core"
import { createNodeApp } from "@rezi-ui/node"

interface State {
  botToken: string
  dmPolicy: "open" | "allowlist"
  groups: boolean
  allowFrom: string
  errors: Record<string, string>
}

export interface TelegramSetupResult {
  botToken: string
  dmPolicy: "open" | "allowlist"
  groups: boolean
  allowFrom: string[]
}

export async function runTelegramConnectWizard(): Promise<TelegramSetupResult | null> {
  const app = createNodeApp<State>({
    initialState: {
      botToken: "",
      dmPolicy: "open",
      groups: false,
      allowFrom: "",
      errors: {},
    },
  })
  let result: TelegramSetupResult | null = null

  app.view((s) =>
    ui.page({
      p: 1,
      gap: 1,
      header: ui.header({ title: "⧁  hive-code · Conectar Telegram" }),
      body: ui.form([
        ui.field({
          label: "Bot Token (obtenido de @BotFather en Telegram)",
          required: true,
          error: s.errors.botToken,
          children: ui.input({
            id: "botToken",
            value: s.botToken,
            onInput: (v) => app.update((prev) => ({ ...prev, botToken: v })),
          }),
        }),
        ui.field({
          label: "Política de mensajes directos",
          children: ui.radioGroup({
            id: "dmPolicy",
            value: s.dmPolicy,
            options: [
              { label: "Abierto — cualquiera puede escribirle al bot", value: "open" },
              { label: "Lista blanca — solo IDs permitidos", value: "allowlist" },
            ],
            onChange: (v) => app.update((prev) => ({ ...prev, dmPolicy: v as "open" | "allowlist" })),
          }),
        }),
        s.dmPolicy === "allowlist"
          ? ui.field({
              label: "IDs permitidos (separados por coma, ej: tg:123456,tg:789012)",
              children: ui.input({
                id: "allowFrom",
                value: s.allowFrom,
                onInput: (v) => app.update((prev) => ({ ...prev, allowFrom: v })),
              }),
            })
          : ui.text(""),
        ui.field({
          label: "",
          children: ui.checkbox({
            id: "groups",
            checked: s.groups,
            label: "Habilitar soporte de grupos de Telegram",
            onChange: (v) => app.update((prev) => ({ ...prev, groups: v })),
          }),
        }),
        ui.actions([
          ui.button({
            id: "connect",
            label: "Conectar",
            intent: "primary",
            onPress: () => {
              if (!s.botToken) {
                app.update((prev) => ({ ...prev, errors: { botToken: "Requerido" } }))
                return
              }
              result = {
                botToken: s.botToken,
                dmPolicy: s.dmPolicy,
                groups: s.groups,
                allowFrom: s.allowFrom
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              }
              app.stop()
            },
          }),
          ui.button({ id: "cancel", label: "Cancelar", onPress: () => app.stop() }),
        ]),
      ]),
    })
  )

  app.keys({ Escape: () => app.stop(), "ctrl+c": () => app.stop() })
  await app.run()
  return result
}
