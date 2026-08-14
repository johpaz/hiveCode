/**
 * `hivecode free` — manage the hivecode-free tier (browser-auth required).
 *
 * Subcommands:
 *   hivecode free              list available free models + auth status
 *   hivecode free set-default  activate hivecode-free as the default provider
 *
 * NOTE: In this architecture, the NVIDIA API key lives in the OPERATOR's
 * backend, not on the user's machine. The client only holds a personal
 * `hivecode_token` obtained via `hivecode login` (browser-based Firebase Auth
 * flow). See docs/API_CONTRACT.md.
 */

import { hiveIntro, hiveOutro, hiveNote } from "../cli-ui.ts"
import { hasStoredAuth } from "@johpaz/hivecode-core/auth/auth-cli"
import { getProvider, listFreeProviderModels, setDefaultProvider } from "./provider-store"

const FREE_PROVIDER_ID = "hivecode-free"

export async function freeList(): Promise<void> {
  hiveIntro("hivecode-free · modelos disponibles vía tu API")

  const auth = await hasStoredAuth()
  const apiBase = process.env.HIVE_FREE_API_URL || "https://api.hivecode.local/v1"

  if (auth.hasToken && !auth.expired) {
    hiveNote("✓ Sesión activa", [
      `  email:     ${auth.email || "—"}`,
      `  expira:    ${auth.expiresAt ? new Date(auth.expiresAt * 1000).toISOString() : "—"}`,
      `  API base:  ${apiBase}`,
    ])
  } else {
    hiveNote("✗ Sin autenticación", [
      "Para usar los modelos hivecode-free necesitas un hivecode_token.",
      "",
      "  hivecode login          (abre tu navegador, Firebase Auth)",
      "",
      "El token lo emite la API del operador tras verificar tu Firebase ID token.",
      "La key de NVIDIA vive en el backend, nunca en tu máquina.",
    ])
  }

  const models = await listFreeProviderModels(FREE_PROVIDER_ID)
  if (models.length === 0) {
    hiveNote("Sin modelos", [
      "No se encontraron modelos con provider_id = 'hivecode-free'.",
      "Corre la migración inicial: hivecode init",
    ])
  } else {
    hiveNote(
      `${models.length} modelos hivecode-free`,
      models.map((m) => `  · ${m.id.padEnd(50)} ctx=${m.context.toString().padStart(8)}  ${m.capabilities}`)
    )
  }

  hiveNote("Cómo usarlos", [
    "  /provider set hivecode-free                     (en el TUI)",
    "  /modelo set hivecode-free moonshotai/kimi-k2.6",
    "  ó: hivecode provider set-default hivecode-free",
    "",
    "Si ves 'Free tier agotado': el cap lo aplica el servidor (default 50K tokens/día).",
  ])

  hiveOutro(auth.hasToken && !auth.expired ? "Listo" : "Sin auth", auth.hasToken && !auth.expired ? "success" : "error")
}

export async function freeSetDefault(): Promise<void> {
  const provider = await getProvider(FREE_PROVIDER_ID)
  if (!provider) {
    hiveOutro(`Provider '${FREE_PROVIDER_ID}' no existe. Ejecuta hivecode init para crear el catálogo base.`, "error")
    return
  }
  await setDefaultProvider(FREE_PROVIDER_ID)
  hiveOutro("hivecode-free es ahora el provider por defecto")
}

export async function freeDispatch(args: string[]): Promise<void> {
  const sub = args[0]
  switch (sub) {
    case "set-default":
    case "set":
      return freeSetDefault()
    case undefined:
    case "list":
    case "ls":
      return freeList()
    default:
      hiveOutro(`Subcomando desconocido: ${sub}. Usa: free | free set-default`, "error")
  }
}
