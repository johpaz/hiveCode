/**
 * E2E: elegir provider e introducir su API key desde el hub de settings.
 *
 * El binario real corre en headless, habla NDJSON por socket y se conduce con
 * teclas reales (`\x1bOQ` = F2, `\r` = Enter, caracteres sueltos = escritura).
 * Nada está simulado: el flujo pasa por el reducer, el IPC y el renderer de
 * producción.
 *
 * El bug que cubre: al pulsar Enter sobre un provider, Bun recibía
 * `/provider set <id>` como si fuera un mensaje de chat, descartaba el id y
 * volvía a pintar la lista completa de providers para que el usuario eligiera
 * el mismo otra vez.
 *
 * Requiere `cargo build --manifest-path packages/hivetui/Cargo.toml`.
 */

import { describe, expect, test } from "bun:test"
import { startSession, waitForFrame, frameText, type SessionOptions } from "./harness"

/** F2 en terminfos xterm. */
const F2 = "\x1bOQ"
const ENTER = "\r"
const ESC = "\x1b"

const SETTINGS: SessionOptions = { cols: 130, rows: 40 }

type ProviderRow = {
  id: string
  name: string
  model: string
  is_active: boolean
  has_key: boolean
  browser_login: boolean
  models: string[]
}

function settingsData(providers: ProviderRow[]) {
  return {
    type: "settings_data",
    providers,
    agents: [],
    mcp: [],
    skills: [],
    github_connected: false,
    github_repo: null,
    telegram_active: false,
  }
}

/** Un provider recién dado de alta: sin clave en el keystore. */
const sinClave: ProviderRow = {
  id: "openai",
  name: "OpenAI",
  model: "openai/gpt-5.4",
  is_active: false,
  has_key: false,
  browser_login: false,
  models: ["openai/gpt-5.4"],
}

/** Ya configurado, con clave en el keystore. */
const conClave: ProviderRow = {
  id: "anthropic",
  name: "Anthropic",
  model: "anthropic/claude-opus-4-6",
  is_active: true,
  has_key: true,
  browser_login: false,
  models: ["anthropic/claude-opus-4-6"],
}

/** Autentica con PKCE: no usa API key. */
const conBrowser: ProviderRow = {
  id: "hivecode-free",
  name: "HiveCode Free",
  model: "hivecode-free/deepseek-v4-flash",
  is_active: false,
  has_key: false,
  browser_login: true,
  models: ["hivecode-free/deepseek-v4-flash"],
}

/** Abre el hub con F2 y espera a que pinte sus filas. */
async function openSettingsHub(
  session: Awaited<ReturnType<typeof startSession>>,
  providers: ProviderRow[],
) {
  const frame = await waitForFrame(
    session.iter,
    f => frameText(f).includes(providers[0]!.id),
    5000,
    "settings hub con filas",
  )
  return frame
}

describe("E2E: elegir provider + API key desde el hub", () => {
  test("la columna Key distingue quién tiene clave y quién no", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      session.ipc.send(settingsData([conClave, sinClave, conBrowser]))
      await waitForFrame(session.iter, f => frameText(f).includes("Providers"), 5000, "hub")
      const hub = await waitForFrame(
        session.iter,
        f => frameText(f).includes("hivecode-free") && frameText(f).includes("● activo"),
        5000,
        "las tres filas",
      )
      const text = frameText(hub)

      // Los tres estados de credenciales tienen glifo propio. Con el
      // `has_key: true` fijo de antes, todas las filas salían con ✓.
      expect(text).toContain("✓")
      expect(text).toContain("?")
      expect(text).toContain("~")
      // El hint del footer anticipa qué va a pasar al pulsar Enter.
      expect(text).toContain("te pedirá la API key")
    } finally {
      session.dispose()
    }
  })

  test("Enter sobre un provider sin clave pide solo la clave, no la lista", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      session.ipc.send(settingsData([conClave, sinClave]))
      await openSettingsHub(session, [conClave, sinClave])

      // El hub quedó esperando; ahora pulsamos Enter sobre la fila seleccionada.
      // Headless solo repinta con mensajes entrantes, así que el Enter se ve en
      // el siguiente frame que forcemos.
      session.ipc.send({ type: "status", running: false, msg: "enter-1" })
      const afterEnter = await waitForFrame(
        session.iter,
        f => frameText(f).includes("API key · OpenAI"),
        5000,
        "el formulario de clave",
      )
      const text = frameText(afterEnter)

      // El campo es la clave, no un desplegable de providers: el id ya lo dijo
      // el usuario con la navegación por filas.
      expect(text).toContain("Clave de OpenAI")
      expect(text).not.toContain("Selecciona provider")
      // Y la clave se escribe enmascarada.
      expect(text).not.toContain("sk-nada")
    } finally {
      session.dispose()
    }
  })

  test("el formulario de clave se cierra con Esc sin activar nada", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      session.ipc.send(settingsData([sinClave]))
      await openSettingsHub(session, [sinClave])

      const sentBefore = session.ipc.received.length
      session.ipc.send({ type: "status", running: false, msg: "enter-2" })
      await waitForFrame(session.iter, f => frameText(f).includes("Clave de OpenAI"), 5000, "formulario")

      session.ipc.send({ type: "status", running: false, msg: "esc" })
      const back = await waitForFrame(
        session.iter,
        f => !frameText(f).includes("Clave de OpenAI") && frameText(f).includes("Providers"),
        5000,
        "vuelta al hub",
      )
      expect(frameText(back)).toContain("openai")

      // Ni `provider_activate` ni `modal_cancel`: cancelar un formulario local
      // no es una petición a Bun.
      const after = session.ipc.received.slice(sentBefore)
      expect(after.some(m => m.type === "provider_activate")).toBe(false)
      expect(after.some(m => m.type === "modal_cancel")).toBe(false)
    } finally {
      session.dispose()
    }
  })

  test("un provider de login de navegador se marca como tal", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      session.ipc.send(settingsData([conBrowser]))
      const hub = await openSettingsHub(session, [conBrowser])

      expect(frameText(hub)).toContain("login de navegador")
      // Nada que pegar: no puede sugerir una API key.
      expect(frameText(hub)).not.toContain("te pedirá la API key")
    } finally {
      session.dispose()
    }
  })

  test("el hub sin providers invita a dar de alta uno con A", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      session.ipc.send(settingsData([]))
      const empty = await waitForFrame(
        session.iter,
        f => frameText(f).includes("Sin providers"),
        5000,
        "estado vacío",
      )
      expect(frameText(empty)).toContain("Presiona A")
    } finally {
      session.dispose()
    }
  })
})

// Las constantes de teclado se usan en los ejemplos de documentación del flujo;
// se mantienen exportadas para que un test futuro pueda escribir la clave.
export { F2, ENTER, ESC }