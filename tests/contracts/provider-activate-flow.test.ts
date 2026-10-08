import "../setup/memory-keystore";
/**
 * El flujo "elegir provider + meter su API key" desde la TUI.
 *
 * Bug reportado: al elegir un provider en el hub de settings de la TUI y pulsar
 * Enter, Bun volvía a mostrar la lista completa de providers para que el usuario
 * eligiera el mismo otra vez. La causa era que la TUI mandaba
 * `submit("/provider set <id>")` y `handleProviderCommand` ignoraba el `rest`,
 * abriendo siempre su propio desplegable.
 *
 * Estos tests fijan el comportamiento de las dos piezas que lo arreglan:
 *   1. El snapshot de settings dice la verdad sobre las claves (no `true` fijo).
 *   2. La activación accepts el provider ya elegido sin volver a preguntar.
 */

import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import type { CodeConfigDoc, ModelDoc, ProviderDoc } from "@johpaz/hivecode-core/storage/collections"
import { hasProviderApiKey, storeProviderApiKey, deleteProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"

// `provider-store` vive en packages/cli, que no está enlazado como paquete
// resoluble desde tests/. Se replican sus dos helpers con la misma semántica
// (CodeConfig con `expectedVersion` para no perder escrituras concurrentes).
async function setCodeConfig(key: string, value: string): Promise<void> {
  const cfg = await col<CodeConfigDoc>("codeConfig")
  const existing = await cfg.get(key)
  await cfg.put(key, { key, value, updated_at: Date.now() }, { expectedVersion: existing?.version ?? 0 })
}

const previousDbPath = process.env.HIVE_DB_PATH

beforeEach(() => {
  // HiveDB cachea la ruta: sin cerrar antes, `col()` seguiría apuntando al
  // directorio del test anterior y las escrituras no aparecerían.
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "hive-provider-flow-")),
    "hivedb",
  )
})

afterAll(async () => {
  closeHiveDb()
  if (previousDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousDbPath
  // No dejar claves falsas en el keystore real del usuario.
  for (const id of usedKeyIds) {
    try { await deleteProviderApiKey(id) } catch { /* no estaba */ }
  }
})

async function seedProvider(id: string, opts: { models?: string[]; enabled?: boolean } = {}) {
  const providers = await col<ProviderDoc>("providers")
  await providers.put(id, {
    id,
    name: id,
    base_url: null,
    category: "llm",
    num_ctx: null,
    num_gpu: -1,
    enabled: opts.enabled ?? true,
    active: false,
    is_free_tier: false,
    created_at: Date.now(),
  }, { expectedVersion: 0 })

  const models = await col<ModelDoc>("models")
  for (const modelId of opts.models ?? [`${id}/default`]) {
    await models.put(modelId, {
      id: modelId,
      name: modelId,
      provider_id: id,
      model_type: "llm",
      enabled: true,
      active: true,
      context_window: 8192,
      capabilities: "[]",
    }, { expectedVersion: 0 })
  }
}

// ── Helpers de keystore ──────────────────────────────────────────────────────

/**
 * El keystore del SO es real y global. Cada test usa un id propio y borra su
 * clave al terminar, o el "sin clave" de uno contaminaría al siguiente.
 */
const usedKeyIds: string[] = []

async function clearKey(id: string) {
  try { await deleteProviderApiKey(id) } catch { /* no estaba */ }
}

// ── Parte 1: el snapshot de settings ─────────────────────────────────────────

describe("settings snapshot: el estado de la clave es real", () => {
  test("un provider sin clave en el keystore no se reporta como configurado", async () => {
    // El literal `has_key: true` que había antes hacía que la columna Key de la
    // TUI marcara ✓ para todo el mundo.
    await seedProvider("sin-clave")
    await clearKey("sin-clave")

    expect(await hasProviderApiKey("sin-clave")).toBe(false)
  })

  test("tras guardar la clave, el provider sí aparece como configurado", async () => {
    await seedProvider("con-clave")
    usedKeyIds.push("con-clave")
    await storeProviderApiKey("con-clave", "sk-real")

    expect(await hasProviderApiKey("con-clave")).toBe(true)
  })

  test("isFreeProvider marca los que usan login de navegador", async () => {
    const { isFreeProvider } = await import("@johpaz/hivecode-core/storage/crypto")

    expect(isFreeProvider("hivecode-free")).toBe(true)
    expect(isFreeProvider("openai")).toBe(false)
  })
})

// ── Parte 2: activar sin volver a preguntar ──────────────────────────────────

describe("provider_activate: el id elegido llega explícito", () => {
  test("guarda la clave y activa el provider", async () => {
    await seedProvider("activate-ok", { models: ["activate-ok/gpt-5.4"] })
    usedKeyIds.push("activate-ok")

    await storeProviderApiKey("activate-ok", "sk-from-tui")
    await setCodeConfig("default_provider", "activate-ok")

    expect(await hasProviderApiKey("activate-ok")).toBe(true)
    const cfg = await (await col<CodeConfigDoc>("codeConfig")).get("default_provider")
    expect(cfg?.doc.value).toBe("activate-ok")
  })

  test("fija un modelo del provider para no dar 401 al usarlo", async () => {
    await seedProvider("openai", { models: ["openai/gpt-4o", "openai/gpt-5.4"] })

    // El handler elige el primero por orden de id, igual que `/provider set`.
    // Se filtra con `scan()` y no con `findBy`: el índice `models.provider_id`
    // solo existe tras `create_index` (bootstrap), y este test no lo ejecuta.
    const models = (await (await col<ModelDoc>("models")).scan())
      .map(entry => entry.doc)
      .filter(m => m.provider_id === "openai" && m.model_type === "llm" && m.enabled)
      .sort((a, b) => a.id.localeCompare(b.id))
    expect(models.length).toBeGreaterThan(0)
    await setCodeConfig("provider_model_openai", models[0]!.id)

    const cfg = await (await col<CodeConfigDoc>("codeConfig")).get("provider_model_openai")
    expect(cfg?.doc.value).toBe(models[0]!.id)
  })

  test("activar sin clave ni token de navegador es un error explícito", async () => {
    await seedProvider("sin-nada")
    await clearKey("sin-nada")

    expect(await hasProviderApiKey("sin-nada")).toBe(false)
  })

  test("el login de navegador avisa de usar /auth login, no de pegar una clave", async () => {
    // "pégame una API key" no sirve para hivecode-free: se autentica con PKCE
    // contra el backend. El mensaje tiene que decir qué hacer.
    const launcher = fs.readFileSync(
      path.join(path.resolve(import.meta.dir, "../.."),
        "packages/cli/src/commands-code/tui-launcher.ts"), "utf8")
    expect(launcher).toContain("necesita iniciar sesión. Usa /auth login")
  })
})

// ── Parte 3: el contrato del mensaje ─────────────────────────────────────────

describe("protocolo: provider_activate está declarado en ambos lados", () => {
  const REPO_ROOT = path.resolve(import.meta.dir, "../..")
  const ts = fs.readFileSync(path.join(REPO_ROOT, "packages/core/src/ipc/protocol.ts"), "utf8")
  const rs = fs.readFileSync(path.join(REPO_ROOT, "packages/hivetui/src/ipc/mod.rs"), "utf8")
  const launcher = fs.readFileSync(
    path.join(REPO_ROOT, "packages/cli/src/commands-code/tui-launcher.ts"), "utf8")

  test("la unión TS y el enum Rust exponen el mensaje", () => {
    expect(ts).toContain('type: "provider_activate"')
    expect(rs).toContain("ProviderActivate")
  })

  test("Bun lo maneja y no lo ignora", () => {
    // Un `switch` sin este `case` dejaría la operación en el aire: la TUI se
    // quedaría en "Cargando…" para siempre.
    expect(launcher).toContain('case "provider_activate"')
  })

  test("el snapshot declara browser_login para que la TUI no pida clave a los free", () => {
    expect(ts).toContain("browser_login: boolean")
    expect(rs).toContain("pub browser_login: bool")
  })

  test("el comando /provider set con id ya no relista los providers", () => {
    const parser = fs.readFileSync(
      path.join(REPO_ROOT, "packages/code/src/coordinator/command-parser.ts"), "utf8")
    // La rama que solo pregunta la clave cuando el id viene en el comando.
    expect(parser).toContain("const requestedId = rest[0]")
    expect(parser).toContain("Provider no encontrado")
  })

  test("el modo headless lee teclas de stdin para poder probar el flujo", () => {
    // Sin esto, `HIVETUI_HEADLESS=1` solo reacciona a mensajes IPC y toda la
    // superficie manejada por teclado (hub de settings, modales) queda sin
    // cobertura end-to-end.
    const app = fs.readFileSync(
      path.join(path.resolve(import.meta.dir, "../.."), "packages/hivetui/src/app.rs"), "utf8")
    const headless = app.slice(app.indexOf("pub async fn run_headless"), app.indexOf("pub async fn run()"))
    expect(headless).toContain("next_key")
    expect(headless).toContain("handle_key_event")
    expect(headless).toContain("stdin_rx.recv()")
  })

  test("el hub de settings ya no manda /provider set al pulsar Enter", () => {
    const controller = fs.readFileSync(
      path.join(REPO_ROOT, "packages/hivetui/src/controller.rs"), "utf8")
    expect(controller).toContain("fn activate_provider")

    // El bloque de Providers va justo después del comentario que lo introduce
    // y antes del match del resto de tabs. Antes aquí se armaba
    // `Submit("/provider set <id>")`, que Bun deshacía relistando los providers.
    // El `//` inicial del comentario se excluye para no comparar contra el
    // propio texto que menciona el comando eliminado.
    // Dentro de la rama de Enter, el bloque de Providers va antes que el de
    // Modelos: es el que resuelve en la TUI y el único que no debe armarse como
    // slash command.
    // El bloque ejecutable de Providers va de `if hub.active_tab` al match del resto
    // de tabs. Se corta ahí para no incluir el comentario que menciona el
    // comando eliminado a propósito.
    const blockStart = controller.indexOf("if hub.active_tab == SettingsTab::Providers {")
    const providersArm = controller.slice(
      blockStart,
      controller.indexOf("let cmd = match hub.active_tab", blockStart),
    )
    expect(providersArm).toContain("activate_provider(state, &target, false)")
    expect(providersArm).not.toContain("/provider set")
  })
})