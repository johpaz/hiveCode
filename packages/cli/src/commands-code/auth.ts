/**
 * `hivecode login` / `hivecode logout` / `hivecode whoami`
 *
 * Browser-based auth flow against the operator's backend.
 * Stores the resulting hivecode_token in Bun.secrets.
 */

import { hiveIntro, hiveOutro, hiveNote } from "../cli-ui.ts"
import {
  runAuthCli, hasStoredAuth, clearAuth,
} from "@johpaz/hivecode-core/auth/auth-cli"

export async function login(): Promise<void> {
  hiveIntro("hivecode · login")
  const status = await hasStoredAuth()
  if (status.hasToken && !status.expired) {
    hiveNote("Ya estás autenticado", [
      `  email:     ${status.email || "—"}`,
      `  expira:    ${status.expiresAt ? new Date(status.expiresAt * 1000).toISOString() : "—"}`,
      "",
      "Si quieres re-autenticarte (rotar token), continúa. Si no, Ctrl+C para salir.",
    ])
  } else if (status.hasToken && status.expired) {
    hiveNote("Token expirado", [
      `  email:     ${status.email || "—"}`,
      "Vamos a refrescarlo. Se abrirá tu navegador.",
    ])
  }

  const apiBase = process.env.HIVE_FREE_API_URL || "https://api.hivecode.local/v1"
  hiveNote("Iniciando flujo de auth", [
    `  API base:  ${apiBase}`,
    "  1. Se abrirá tu navegador",
    "  2. Inicia sesión con Google o email",
    "  3. Al volver a la terminal, el token ya estará guardado",
    "",
    "Presiona Ctrl+C en cualquier momento para cancelar.",
  ])

  const result = await runAuthCli({ apiBase })
  if (!result) {
    hiveOutro("Auth cancelada o fallida", "error")
    process.exitCode = 1
    return
  }

  hiveNote("✅ Token guardado", [
    `  email:     ${result.email || "—"}`,
    `  expira:    ${result.expiresAt ? new Date(result.expiresAt * 1000).toISOString() : "—"}`,
    `  storage:   Bun.secrets (hive-code / provider.hivecode-free)`,
    "",
    "Ya puedes usar los modelos hivecode-free:",
    "  /free                              (en el TUI)",
    "  /free set                          (activar como provider por defecto)",
    "  /modelo set hivecode-free <modelo> (elegir modelo)",
  ])
  hiveOutro("Listo")
}

export async function logout(): Promise<void> {
  const status = await hasStoredAuth()
  if (!status.hasToken) {
    hiveNote("Sin sesión", ["No hay token guardado — no hay nada que cerrar."])
    hiveOutro("Listo")
    return
  }
  await clearAuth()
  hiveNote("Sesión cerrada", [
    `  email borrado: ${status.email || "—"}`,
    "  Token removido de Bun.secrets.",
    "",
    "Vuelve a correr `hivecode login` cuando quieras re-autenticarte.",
  ])
  hiveOutro("Listo")
}

export async function whoami(): Promise<void> {
  hiveIntro("hivecode · sesión actual")
  const status = await hasStoredAuth()
  if (!status.hasToken) {
    hiveNote("No autenticado", [
      "No hay hivecode_token guardado.",
      "Corre:  hivecode login",
    ])
    hiveOutro("Sin sesión", "error")
    process.exitCode = 1
    return
  }
  if (status.expired) {
    hiveNote("⚠ Token expirado", [
      `  email:     ${status.email || "—"}`,
      `  expira:    ${status.expiresAt ? new Date(status.expiresAt * 1000).toISOString() : "—"}`,
      "",
      "Refresca con:  hivecode login",
    ])
    hiveOutro("Token expirado", "error")
    process.exitCode = 1
    return
  }
  hiveNote("✓ Sesión activa", [
    `  email:     ${status.email || "—"}`,
    `  expira:    ${status.expiresAt ? new Date(status.expiresAt * 1000).toISOString() : "—"}`,
  ])
  hiveOutro("Listo")
}
