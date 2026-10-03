/**
 * E2E: elegir provider e introducir su API key desde el hub de settings.
 *
 * El binario real corre en headless, habla NDJSON por socket y se conduce con
 * teclas reales sobre su stdin (`\x1bOQ` = F2, `\r` = Enter). Nada está simulado:
 * el flujo pasa por el reducer, el IPC y el renderer de producción.
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
const DOWN = "\x1b[B"

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

/**
 * ¿El mensaje lleva una clave?
 *
 * `Option::None` de serde se serializa como `null`, no se omite el campo, así
 * que "sin clave" puede llegar de las dos formas según el cliente.
 */
function carriesKey(msg: Record<string, unknown>): boolean {
  return typeof msg.api_key === "string" && msg.api_key.length > 0
}

/** Recién dado de alta, sin clave en el keystore. */
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

/**
 * Abre el hub con F2 y espera a que pinte la fila de `provider`.
 *
 * `request_settings` se responde con el snapshot: el TUI solo aplica
 * `SettingsData` si el hub está montado, así que el orden importa.
 */
async function openSettingsHub(
  session: Awaited<ReturnType<typeof startSession>>,
  providers: ProviderRow[],
) {
  // El hub pide los datos al abrirse; responder con la fila buscada.
  const stop = watchRequestSettings(session, providers)
  session.type(F2)
  try {
    return await waitForFrame(
      session.iter,
      f => providers.every(p => frameText(f).includes(p.id)),
      5000,
      "el hub con sus filas",
    )
  } finally {
    stop()
  }
}

/** Responde a cada `request_settings` con el snapshot, como hace tui-launcher. */
function watchRequestSettings(
  session: Awaited<ReturnType<typeof startSession>>,
  providers: ProviderRow[],
): () => void {
  let sent = 0
  const timer = setInterval(() => {
    const asked = session.ipc.received.filter(m => m.type === "request_settings").length
    while (sent < asked) {
      sent += 1
      session.ipc.send(settingsData(providers))
    }
  }, 20)
  return () => clearInterval(timer)
}

describe("E2E: elegir provider + API key desde el hub", () => {
  test("la columna Key distingue quién tiene clave y quién no", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      const hub = await openSettingsHub(session, [conClave, sinClave, conBrowser])
      const text = frameText(hub)

      // Los tres estados de credenciales tienen glifo propio. Con el
      // `has_key: true` fijo de antes, todas las filas salían con ✓.
      expect(text).toContain("✓")
      expect(text).toContain("?")
      expect(text).toContain("~")
      expect(text).toContain("● activo")
    } finally {
      session.dispose()
    }
  })

  test("Enter sobre un provider sin clave pide solo la clave, no la lista", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      await openSettingsHub(session, [sinClave])

      session.type(ENTER)
      const form = await waitForFrame(
        session.iter,
        f => frameText(f).includes("Clave de OpenAI"),
        5000,
        "el formulario de clave",
      )
      const text = frameText(form)

      // El campo es la clave, no un desplegable de providers: el id ya lo dijo
      // el usuario al moverse por las filas.
      expect(text).not.toContain("Selecciona provider")
      expect(text).not.toContain("hiveagents")

      // Y nada sale hacia Bun hasta que se confirme.
      expect(session.ipc.received.some(m => m.type === "provider_activate")).toBe(false)
    } finally {
      session.dispose()
    }
  })

  test("la clave se envía en su propio mensaje, no como comando de chat", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      await openSettingsHub(session, [sinClave])
      session.type(ENTER)
      await waitForFrame(session.iter, f => frameText(f).includes("Clave de OpenAI"), 5000, "formulario")

      session.type("sk-secreto-123")
      session.type(ENTER)

      const activate = await session.ipc.waitForMessage("provider_activate", 5000)
      expect(activate.provider_id).toBe("openai")
      expect(activate.api_key).toBe("sk-secreto-123")

      // El bug original: el provider se elegía de una lista en Bun, y el id del
      // comando se descartaba. Nada de `/provider set` por aquí.
      expect(session.ipc.received.some(m => m.type === "submit")).toBe(false)
    } finally {
      session.dispose()
    }
  })

  test("la clave nunca se dibuja en claro en pantalla", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      await openSettingsHub(session, [sinClave])
      session.type(ENTER)
      await waitForFrame(session.iter, f => frameText(f).includes("Clave de OpenAI"), 5000, "formulario")

      session.type("sk-secreto-123")
      const form = await waitForFrame(
        session.iter,
        f => frameText(f).includes("•"),
        5000,
        "la clave enmascarada",
      )

      expect(frameText(form)).toContain("•")
      expect(frameText(form)).not.toContain("sk-secreto-123")
    } finally {
      session.dispose()
    }
  })

  test("el formulario se cierra con Esc sin activar nada", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      await openSettingsHub(session, [sinClave])
      session.type(ENTER)
      await waitForFrame(session.iter, f => frameText(f).includes("Clave de OpenAI"), 5000, "formulario")

      const before = session.ipc.received.length
      session.type(ESC)
      const back = await waitForFrame(
        session.iter,
        f => !frameText(f).includes("Clave de OpenAI") && frameText(f).includes("Configuración"),
        5000,
        "vuelta al hub",
      )

      // Cancelar un formulario local no es una petición a Bun: ni
      // `provider_activate` ni `modal_cancel`.
      const after = session.ipc.received.slice(before)
      expect(after.some(m => m.type === "provider_activate")).toBe(false)
      expect(after.some(m => m.type === "modal_cancel")).toBe(false)
      // Se vuelve al hub, no al chat.
      expect(frameText(back)).toContain("openai")
    } finally {
      session.dispose()
    }
  })

  test("navegar hasta la fila correcta y activarla no vuelve a preguntar el provider", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      // La primera fila tiene clave: Enter debe activarla directo, sin modal.
      await openSettingsHub(session, [conClave, sinClave])
      session.type(ENTER)

      const activate = await session.ipc.waitForMessage("provider_activate", 5000)
      expect(activate.provider_id).toBe("anthropic")
      // Sin clave que aportar: el campo se omite para que Bun no la pida.
      expect(carriesKey(activate)).toBe(false)
    } finally {
      session.dispose()
    }
  })

  test("una fila de login de navegador no pide API key", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      await openSettingsHub(session, [conBrowser])

      session.type(ENTER)
      const activate = await session.ipc.waitForMessage("provider_activate", 5000)
      expect(activate.provider_id).toBe("hivecode-free")
      expect(carriesKey(activate)).toBe(false)
      // No se abrió ningún formulario: el footer lo advertía de antemano.
      expect(session.ipc.received.some(m => m.type === "modal_submit")).toBe(false)
    } finally {
      session.dispose()
    }
  })

  test("el hub sin providers invita a dar de alta uno con A", async () => {
    const session = await startSession("approval", SETTINGS)
    try {
      const stop = watchRequestSettings(session, [])
      session.type(F2)
      const empty = await waitForFrame(
        session.iter,
        f => frameText(f).includes("Sin providers"),
        5000,
        "estado vacío",
      )
      stop()

      expect(frameText(empty)).toContain("Presiona A")
    } finally {
      session.dispose()
    }
  })
})

// `DOWN` queda exportado para scenarios que recorran varias filas.
export { F2, ENTER, ESC, DOWN }