import { ui } from "@rezi-ui/core"
import { createNodeApp } from "@rezi-ui/node"

interface State {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  errors: Record<string, string>
}

export interface ProviderSetupResult {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
}

export async function runProviderSetupWizard(
  knownProviders: string[] = []
): Promise<ProviderSetupResult | null> {
  const app = createNodeApp<State>({
    initialState: { provider: "", apiKey: "", baseUrl: "", model: "", errors: {} },
  })
  let result: ProviderSetupResult | null = null

  app.view((s) =>
    ui.page({
      p: 1,
      gap: 1,
      header: ui.header({ title: "⧁  hive-code · Configurar Provider" }),
      body: ui.form([
        knownProviders.length > 0
          ? ui.field({
              label: "Provider",
              required: true,
              error: s.errors.provider,
              children: ui.select({
                id: "provider",
                value: s.provider,
                options: knownProviders.map((p) => ({ label: p, value: p })),
                onChange: (v) => app.update((prev) => ({ ...prev, provider: v })),
              }),
            })
          : ui.field({
              label: "Nombre del Provider",
              required: true,
              error: s.errors.provider,
              children: ui.input({
                id: "provider",
                value: s.provider,
                onInput: (v) => app.update((prev) => ({ ...prev, provider: v })),
              }),
            }),
        ui.field({
          label: "API Key",
          required: true,
          error: s.errors.apiKey,
          children: ui.input({
            id: "apiKey",
            value: s.apiKey,
            onInput: (v) => app.update((prev) => ({ ...prev, apiKey: v })),
          }),
        }),
        ui.field({
          label: "Base URL (opcional)",
          children: ui.input({
            id: "baseUrl",
            value: s.baseUrl,
            onInput: (v) => app.update((prev) => ({ ...prev, baseUrl: v })),
          }),
        }),
        ui.field({
          label: "Modelo por defecto (opcional)",
          children: ui.input({
            id: "model",
            value: s.model,
            onInput: (v) => app.update((prev) => ({ ...prev, model: v })),
          }),
        }),
        ui.actions([
          ui.button({
            id: "submit",
            label: "Guardar",
            intent: "primary",
            onPress: () => {
              const errs: Record<string, string> = {}
              if (!s.provider) errs.provider = "Requerido"
              if (!s.apiKey) errs.apiKey = "Requerido"
              if (Object.keys(errs).length) {
                app.update((prev) => ({ ...prev, errors: errs }))
                return
              }
              result = { provider: s.provider, apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model }
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
