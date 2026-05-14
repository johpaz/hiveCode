import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import {
  getTestDb, resetTestDb, cleanupTestDb,
  seedProvider, seedConfig,
} from "../helpers/setup-db"

// ─── provider add + set-default ───────────────────────────────────────────────

describe("config-flow: provider add + set-default", () => {
  beforeAll(() => { resetTestDb() })
  afterAll(() => { cleanupTestDb() })

  test("insertar provider persiste en tabla providers", () => {
    // ARMAR: DB vacía
    const db = getTestDb()
    // ACTUAR
    db.query(
      "INSERT OR REPLACE INTO providers (id, name, base_url, enabled) VALUES (?, ?, ?, 1)"
    ).run("anthropic", "Anthropic", "https://api.anthropic.com")
    // NOTAR
    const row = db.query("SELECT * FROM providers WHERE id = 'anthropic'").get() as any
    expect(row).not.toBeNull()
    expect(row.name).toBe("Anthropic")
    expect(row.enabled).toBe(1)
    // ESTADO
    expect(row.base_url).toBe("https://api.anthropic.com")
  })

  test("set-default actualiza code_config['default_provider']", () => {
    // ARMAR: provider ya insertado
    const db = getTestDb()
    // ACTUAR
    db.query(
      "INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_provider', ?)"
    ).run("anthropic")
    // ESTADO
    const row = db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get() as any
    expect(row?.value).toBe("anthropic")
  })

  test("modelo del provider persiste en code_config", () => {
    // ACTUAR
    const db = getTestDb()
    db.query(
      "INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)"
    ).run("provider_model_anthropic", "claude-sonnet-4-6")
    // ESTADO
    const row = db.query(
      "SELECT value FROM code_config WHERE key = 'provider_model_anthropic'"
    ).get() as any
    expect(row?.value).toBe("claude-sonnet-4-6")
  })

  test("eliminar provider borra de providers, no afecta code_config", () => {
    // ARMAR: provider + config existentes
    seedProvider("openai", "OpenAI")
    seedConfig("default_provider", "openai")
    const db = getTestDb()
    // ACTUAR
    db.query("DELETE FROM providers WHERE id = 'openai'").run()
    // NOTAR — providers ya no tiene la fila
    const provRow = db.query("SELECT id FROM providers WHERE id = 'openai'").get()
    expect(provRow).toBeNull()
    // ESTADO — code_config no tiene cascada, la clave sigue
    const cfgRow = db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get() as any
    expect(cfgRow?.value).toBe("openai")
  })

  test("providerList: rows contienen modelo y marcador de default", () => {
    // ARMAR
    resetTestDb()
    seedProvider("groq", "Groq")
    seedConfig("default_provider", "groq")
    seedConfig("provider_model_groq", "llama3-70b-8192")
    const db = getTestDb()
    // ACTUAR — simular la query que usa providerList
    const rows = db.query("SELECT id, name, base_url, enabled FROM providers ORDER BY id").all() as any[]
    const defaultProvider = (db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get() as any)?.value ?? ""
    const modelRows = db.query("SELECT key, value FROM code_config WHERE key LIKE 'provider_model_%'").all() as any[]
    const modelMap = new Map(modelRows.map((r: any) => [r.key.replace("provider_model_", ""), r.value]))
    // NOTAR
    expect(rows.length).toBe(1)
    expect(defaultProvider).toBe("groq")
    expect(modelMap.get("groq")).toBe("llama3-70b-8192")
    const groqRow = rows[0]
    expect(groqRow.id).toBe("groq")
  })
})

// ─── telegram connect / disconnect / status ───────────────────────────────────

describe("config-flow: telegram connect", () => {
  beforeEach(() => { resetTestDb() })
  afterAll(() => { cleanupTestDb() })

  test("connect inserta en channels con type='telegram'", () => {
    // ARMAR
    const db = getTestDb()
    const config = { botToken: "bot123:TOKEN", dmPolicy: "open", groups: true, allowFrom: [] }
    const configEncrypted = Buffer.from(JSON.stringify(config)).toString("base64")
    // ACTUAR
    db.query(
      "INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status) VALUES (?, ?, ?, 1, 'connected')"
    ).run("telegram", "telegram", configEncrypted)
    // NOTAR
    const row = db.query("SELECT id, type, enabled, status FROM channels WHERE id = 'telegram'").get() as any
    expect(row).not.toBeNull()
    expect(row.type).toBe("telegram")
    expect(row.enabled).toBe(1)
    expect(row.status).toBe("connected")
  })

  test("config_encrypted decodifica a objeto con dmPolicy, groups, allowFrom", () => {
    // ARMAR
    const db = getTestDb()
    const config = { botToken: "bot123:TOKEN", dmPolicy: "allowlist", groups: false, allowFrom: ["@alice", "@bob"] }
    const configEncrypted = Buffer.from(JSON.stringify(config)).toString("base64")
    db.query(
      "INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status) VALUES (?, ?, ?, 1, 'connected')"
    ).run("telegram", "telegram", configEncrypted)
    // ACTUAR
    const row = db.query("SELECT config_encrypted FROM channels WHERE id = 'telegram'").get() as any
    const decoded = JSON.parse(Buffer.from(row.config_encrypted, "base64").toString())
    // NOTAR
    expect(decoded.dmPolicy).toBe("allowlist")
    expect(decoded.groups).toBe(false)
    expect(decoded.allowFrom).toEqual(["@alice", "@bob"])
  })

  test("disconnect → enabled=0, status='disconnected'", () => {
    // ARMAR
    const db = getTestDb()
    db.query(
      "INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status) VALUES (?, ?, ?, 1, 'connected')"
    ).run("telegram", "telegram", Buffer.from("{}").toString("base64"))
    // ACTUAR
    db.query(
      "UPDATE channels SET enabled = 0, status = 'disconnected' WHERE id = 'telegram'"
    ).run()
    // ESTADO
    const row = db.query("SELECT enabled, status FROM channels WHERE id = 'telegram'").get() as any
    expect(row.enabled).toBe(0)
    expect(row.status).toBe("disconnected")
  })

  test("status query devuelve configuración completa", () => {
    // ARMAR
    const db = getTestDb()
    const config = { botToken: "bot:TKN", dmPolicy: "open", groups: true, allowFrom: [] }
    const enc = Buffer.from(JSON.stringify(config)).toString("base64")
    db.query(
      "INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status) VALUES (?, ?, ?, 1, 'connected')"
    ).run("telegram", "telegram", enc)
    // ACTUAR — query usada por telegramStatus
    const row = db.query("SELECT * FROM channels WHERE id = 'telegram'").get() as any
    // NOTAR
    expect(row.enabled).toBe(1)
    expect(row.status).toBe("connected")
    const decoded = JSON.parse(Buffer.from(row.config_encrypted, "base64").toString())
    expect(decoded.dmPolicy).toBe("open")
    expect(decoded.groups).toBe(true)
  })

  test("connect con policy=allowlist persiste allowFrom como array", () => {
    // ARMAR
    const db = getTestDb()
    const config = {
      botToken: "bot:TKN",
      dmPolicy: "allowlist",
      groups: false,
      allowFrom: ["@maria", "@carlos"],
    }
    const enc = Buffer.from(JSON.stringify(config)).toString("base64")
    // ACTUAR
    db.query(
      "INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status) VALUES (?, ?, ?, 1, 'connected')"
    ).run("telegram", "telegram", enc)
    // ESTADO
    const row = db.query("SELECT config_encrypted FROM channels WHERE id = 'telegram'").get() as any
    const decoded = JSON.parse(Buffer.from(row.config_encrypted, "base64").toString())
    expect(Array.isArray(decoded.allowFrom)).toBe(true)
    expect(decoded.allowFrom).toContain("@maria")
    expect(decoded.allowFrom).toContain("@carlos")
  })

  test("sobrescribir connect actualiza la configuración existente", () => {
    // ARMAR — primera conexión
    const db = getTestDb()
    const cfg1 = { botToken: "bot:OLD", dmPolicy: "open", groups: false, allowFrom: [] }
    db.query(
      "INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status) VALUES (?, ?, ?, 1, 'connected')"
    ).run("telegram", "telegram", Buffer.from(JSON.stringify(cfg1)).toString("base64"))
    // ACTUAR — segunda conexión sobrescribe
    const cfg2 = { botToken: "bot:NEW", dmPolicy: "allowlist", groups: true, allowFrom: ["@admin"] }
    db.query(
      "INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status) VALUES (?, ?, ?, 1, 'connected')"
    ).run("telegram", "telegram", Buffer.from(JSON.stringify(cfg2)).toString("base64"))
    // ESTADO
    const row = db.query("SELECT config_encrypted FROM channels WHERE id = 'telegram'").get() as any
    const decoded = JSON.parse(Buffer.from(row.config_encrypted, "base64").toString())
    expect(decoded.botToken).toBe("bot:NEW")
    expect(decoded.dmPolicy).toBe("allowlist")
  })
})

// ─── provider guard flow ──────────────────────────────────────────────────────

describe("config-flow: provider guard flow", () => {
  beforeAll(() => { resetTestDb() })
  afterAll(() => { cleanupTestDb() })

  test("DB sin default_provider → query retorna null", () => {
    // ARMAR: DB sin config
    const db = getTestDb()
    // ACTUAR
    const row = db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get()
    // NOTAR
    expect(row).toBeNull()
  })

  test("DB con default_provider='groq' → query retorna 'groq'", () => {
    // ARMAR
    seedConfig("default_provider", "groq")
    // ACTUAR
    const db = getTestDb()
    const row = db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get() as any
    // NOTAR
    expect(row?.value).toBe("groq")
  })

  test("proveedor habilitado → enabled=1", () => {
    // ARMAR
    seedProvider("openai", "OpenAI", { enabled: 1 })
    // ACTUAR
    const db = getTestDb()
    const row = db.query("SELECT enabled FROM providers WHERE id = 'openai'").get() as any
    // NOTAR
    expect(row?.enabled).toBe(1)
  })

  test("proveedor deshabilitado → enabled=0", () => {
    // ARMAR
    seedProvider("disabled-prov", "Disabled", { enabled: 0 })
    // ACTUAR
    const db = getTestDb()
    const row = db.query("SELECT enabled FROM providers WHERE id = 'disabled-prov'").get() as any
    // NOTAR
    expect(row?.enabled).toBe(0)
  })
})
