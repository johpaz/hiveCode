import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import { runReflector } from "../agent/reflector"
import { callLLM, resolveProviderConfig } from "@johpaz/hivecode-core/agent/llm-client"
import { saveScratchpadNote, getScratchpad, deleteScratchpadNote } from "@johpaz/hivecode-core/agent/conversation-store"
import { hasProviderApiKey, storeProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"

export interface ContextState {
  sessionId: string
  activeProvider: string
  activeModel: string
  activeMode: "plan" | "approval" | "auto"
  activeMcp: string[]
  activeSkills: string[]
  projectPath: string
}

export interface MenuItem {
  label: string
  cmd: string
  desc: string
}

export interface ModalField {
  key: string
  label: string
  placeholder: string
  required: boolean
  secret: boolean
  field_type: "text" | "select"
  options?: string[]
  default_value?: string
}

export interface UiCallbacks {
  suspendTui?: () => Promise<void>
  resumeTui?: () => void
  runProviderSetupWizard?: (knownProviders: string[], version: string) => Promise<{ provider: string; baseUrl?: string; apiKey: string; model?: string } | null>
  runTelegramConnectWizard?: () => Promise<Record<string, any> | null>
  showConfigModal?: (command: string, title: string, fields: ModalField[]) => Promise<Record<string, string> | null>
  showInfoModal?: (title: string, content: string) => Promise<void>
  executeTask?: (task: string, mode: string) => Promise<string>
}

export interface CommandResult {
  handled: boolean
  output?: string
  menu?: MenuItem[]
  newState?: Partial<ContextState>
}

export interface ProviderRow {
  id: string
  name: string
  base_url: string | null
  enabled: number
}

const VERSION = "1.0.0"
const GIT_HASH = process.env.GIT_HASH || "dev"

function getCtx(db: ReturnType<typeof getDb>): ContextState {
  const session = db.query(
    "SELECT id FROM code_sessions ORDER BY id DESC LIMIT 1"
  ).get() as { id: string } | undefined

  const sessionId = session?.id ?? "none"
  const provider = (db.query(
    "SELECT value FROM code_config WHERE key = 'default_provider'"
  ).get() as any)?.value ?? ""
  const model = provider ? (db.query(
    "SELECT value FROM code_config WHERE key = ?"
  ).get(`provider_model_${provider}`) as any)?.value ?? "" : ""
  const mode = (db.query(
    "SELECT value FROM code_config WHERE key = 'default_mode'"
  ).get() as any)?.value ?? "auto"
  const projectPath = (db.query(
    "SELECT project_path FROM code_sessions ORDER BY id DESC LIMIT 1"
  ).get() as any)?.project_path ?? process.cwd()

  return {
    sessionId,
    activeProvider: provider,
    activeModel: model,
    activeMode: mode as "plan" | "approval" | "auto",
    activeMcp: [],
    activeSkills: [],
    projectPath,
  }
}

function fmtProvider(status: ProviderRow, isActive: boolean, model: string): string {
  const tag = isActive ? "  [ACTIVO]" : "  [inactivo]"
  return `  \u25b8 ${status.name.padEnd(18)} ${model.padEnd(20)} ${tag}`
}

function renderProviderList(providers: ProviderRow[], activeId: string, modelMap: Map<string, string>): string {
  const lines = providers.map(p => {
    const model = modelMap.get(p.id) ?? "default"
    return fmtProvider(p, p.id === activeId, model)
  })
  return [
    "",
    "  Providers configurados:",
    "",
    ...lines,
    "",
    "  Cambiar con: /provider set <nombre>",
    "  Agregar con:  /provider add <nombre>",
    "",
  ].join("\n")
}

const ALL_COMMANDS = [
  { command: "/ace status", category: "ace", description: "estado del aprendizaje adaptativo" },
  { command: "/ace playbook list", category: "ace", description: "reglas aprendidas del playbook" },
  { command: "/ace playbook reset", category: "ace", description: "reiniciar playbook" },
  { command: "/ace reflector run", category: "ace", description: "forzar analisis de trazas" },
  { command: "/doctor", category: "system", description: "diagnostico completo del sistema" },
  { command: "/env", category: "system", description: "variables de entorno no sensibles" },
  { command: "/plan", category: "task", description: "diseñar tarea sin ejecutar" },
  { command: "/run", category: "task", description: "ejecutar tarea en modo actual" },
  { command: "/github status", category: "github", description: "estado de token github" },
  { command: "/github whoami", category: "github", description: "usuario autenticado en github" },
  { command: "/github set-repo", category: "github", description: "vincular repositorio github" },
  { command: "/github connect", category: "github", description: "conectar con github (token PAT)" },
  { command: "/github disconnect", category: "github", description: "desconectar github" },
  { command: "/help", category: "system", description: "ayuda de comandos" },
  { command: "/logs list", category: "logs", description: "ver logs del sistema" },
  { command: "/logs follow", category: "logs", description: "seguir logs en tiempo real" },
  { command: "/mcp list", category: "mcp", description: "listar servidores mcp" },
  { command: "/mcp add", category: "mcp", description: "agregar servidor mcp" },
  { command: "/mcp connect", category: "mcp", description: "conectar servidor mcp" },
  { command: "/mcp load", category: "mcp", description: "cargar config mcp desde archivo" },
  { command: "/mcp enable", category: "mcp", description: "habilitar servidor mcp" },
  { command: "/mcp disable", category: "mcp", description: "deshabilitar servidor mcp" },
  { command: "/mcp test", category: "mcp", description: "probar servidor mcp" },
  { command: "/mode get", category: "mode", description: "ver modo actual" },
  { command: "/mode set", category: "mode", description: "cambiar modo plan approval auto" },
  { command: "/mode history", category: "mode", description: "historial de cambios de modo" },
  { command: "/modelo list", category: "modelo", description: "listar modelos disponibles" },
  { command: "/modelo set", category: "modelo", description: "cambiar modelo activo" },
  { command: "/modelo info", category: "modelo", description: "informacion del modelo" },
  { command: "/narrative show", category: "narrative", description: "mostrar entradas del narrativo" },
  { command: "/narrative search", category: "narrative", description: "buscar en narrativo con fts5" },
  { command: "/narrative export", category: "narrative", description: "exportar narrativo completo" },
  { command: "/provider list", category: "provider", description: "listar providers configurados" },
  { command: "/provider add", category: "provider", description: "agregar provider de ia" },
  { command: "/provider set", category: "provider", description: "cambiar provider activo" },
  { command: "/provider test", category: "provider", description: "probar conexion al provider" },
  { command: "/provider status", category: "provider", description: "estado de todos los providers" },
  { command: "/skill list", category: "skill", description: "listar skills disponibles" },
  { command: "/skill enable", category: "skill", description: "habilitar skill" },
  { command: "/skill disable", category: "skill", description: "deshabilitar skill" },
  { command: "/skill info", category: "skill", description: "informacion de skill" },
  { command: "/skill add", category: "skill", description: "importar skill desde archivo" },
  { command: "/task list", category: "task", description: "listar tareas recientes" },
  { command: "/task status", category: "task", description: "estado detallado de tarea" },
  { command: "/task cancel", category: "task", description: "cancelar tarea en curso" },
  { command: "/task rollback", category: "task", description: "revertir cambios de tarea" },
  { command: "/telegram status", category: "telegram", description: "estado de telegram" },
  { command: "/telegram connect", category: "telegram", description: "conectar telegram" },
  { command: "/telegram disconnect", category: "telegram", description: "desconectar telegram" },
  { command: "/telegram edit", category: "telegram", description: "editar configuracion telegram" },
  { command: "/version", category: "system", description: "version de hivecode" },
]

export function syncCommandsToFTS(db: ReturnType<typeof getDb>): void {
  try {
    db.run("DELETE FROM code_commands_fts")
    const stmt = db.prepare("INSERT INTO code_commands_fts (command, category, description) VALUES (?, ?, ?)")
    for (const cmd of ALL_COMMANDS) {
      stmt.run(cmd.command, cmd.category, cmd.description)
    }
  } catch (err) {
    logger.warn("[command-parser] Failed to sync commands to FTS:", (err as Error).message)
  }
}

function renderSuggestions(input: string): string[] {
  const prefix = input.startsWith("/") ? input.slice(1) : input
  if (!prefix || prefix.length < 1) {
    console.error(`[suggestions] empty prefix, returning first 20 commands`)
    return ALL_COMMANDS.slice(0, 20).map(c => c.command)
  }
  try {
    const db = getDb()
    const rows = db.query(`
      SELECT command FROM code_commands_fts
      WHERE code_commands_fts MATCH ?
      ORDER BY rank
      LIMIT 20
    `).all(`${prefix}*`) as { command: string }[]
    if (rows.length > 0) {
      console.error(`[suggestions] FTS match for "${prefix}*": ${rows.length} results`)
      return rows.map(r => r.command)
    }
  } catch (e) {
    console.error(`[suggestions] FTS error: ${(e as Error).message}`)
    // Fallback to simple prefix match if FTS fails
  }
  const match = ALL_COMMANDS.filter(c => c.command.startsWith("/" + prefix))
  console.error(`[suggestions] prefix fallback for "${prefix}": ${match.length} results`)
  return match.slice(0, 20).map(c => c.command)
}

function runDoctor(db: ReturnType<typeof getDb>): string {
  const checks: string[] = []
  try {
    const bunVer = process.versions.bun ?? "unknown"
    checks.push(`  \u2713 Bun ${bunVer}`)
  } catch { checks.push("  \u2717 Bun version check failed") }

  try {
    const providers = db.query("SELECT id, name FROM providers WHERE enabled = 1").all() as ProviderRow[]
    checks.push(`  \u2713 Providers: ${providers.length} enabled`)
  } catch { checks.push("  \u2717 Provider check failed") }

  try {
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as { name: string }[]
    checks.push(`  \u2713 SQLite: ${tables.length} tables`)
  } catch { checks.push("  \u2717 SQLite check failed") }

  return [
    "",
    "  Diagn\u00f3stico del sistema:",
    "",
    ...checks,
    "",
  ].join("\n")
}

const HELP_CATEGORIES: Record<string, { desc: string; commands: string[] }> = {
  provider:  { desc: "Configurar providers de IA", commands: ["/provider list", "/provider add", "/provider set", "/provider test", "/provider status"] },
  modelo:    { desc: "Seleccionar modelo + contexto", commands: ["/modelo list", "/modelo set", "/modelo info"] },
  mcp:       { desc: "Integrar servidores MCP", commands: ["/mcp list", "/mcp add", "/mcp enable", "/mcp disable", "/mcp test"] },
  skill:     { desc: "Cargar y activar skills", commands: ["/skill list", "/skill enable", "/skill disable", "/skill info", "/skill add"] },
  mode:      { desc: "Cambiar modo Plan/Approval/Auto", commands: ["/mode get", "/mode set", "/mode history"] },
  task:      { desc: "Gestionar tareas", commands: ["/task list", "/task status", "/task cancel", "/task rollback"] },
  narrative: { desc: "Buscar en el historial", commands: ["/narrative show", "/narrative search", "/narrative export"] },
  ace:       { desc: "Aprendizaje adaptativo", commands: ["/ace status", "/ace playbook list", "/ace playbook reset", "/ace reflector run"] },
  github:    { desc: "Integraci\u00f3n con GitHub", commands: ["/github status", "/github whoami", "/github set-repo", "/github connect", "/github disconnect"] },
  system:    { desc: "Sistema y diagn\u00f3stico", commands: ["/doctor", "/version", "/env", "/help"] },
}

function renderHelp(topic?: string): string {
  if (topic) {
    const clean = topic.replace(/^\//, "")
    const lines: string[] = []

    for (const [cat, info] of Object.entries(HELP_CATEGORIES)) {
      const match = info.commands.find(c => c.replace(/^\//, "").startsWith(clean))
      if (match) {
        lines.push(`  ${match}`)
        lines.push(`  ${"\u2500".repeat(match.length)}`)
        lines.push("")
        lines.push(`  ${info.desc}`)
        lines.push("")
        if (match === "/provider set") {
          lines.push("  SINTAXIS")
          lines.push('  /provider set <nombre>')
          lines.push("")
          lines.push("  ARGUMENTOS")
          lines.push("  <nombre>   nombre del provider (anthropic, openai, groq, etc.)")
          lines.push("")
          lines.push("  EJEMPLOS")
          lines.push("  /provider set anthropic")
          lines.push("  /provider set openai")
          lines.push("")
          lines.push("  NOTAS")
          lines.push("  \u00b7 El provider debe estar configurado previamente")
          lines.push("  \u00b7 Puedes ver disponibles con: /provider list")
          lines.push("  \u00b7 El cambio se aplica inmediatamente")
        } else if (match === "/skill add") {
          lines.push("  SINTAXIS")
          lines.push("  /skill add <path>")
          lines.push("")
          lines.push("  ARGUMENTOS")
          lines.push("  <path>    ruta al archivo .md de la skill")
          lines.push("")
          lines.push("  EJEMPLOS")
          lines.push('  /skill add ~/my-skills/custom_auth.md')
        } else if (match === "/mode set") {
          lines.push("  SINTAXIS")
          lines.push("  /mode set <plan|approval|auto>")
          lines.push("")
          lines.push("  ARGUMENTOS")
          lines.push("  <mode>    plan | approval | auto")
          lines.push("")
          lines.push("  EJEMPLOS")
          lines.push("  /mode set plan")
          lines.push("  /mode set auto")
        } else if (match === "/modelo set") {
          lines.push("  SINTAXIS")
          lines.push("  /modelo set <provider> <modelo>")
          lines.push("")
          lines.push("  ARGUMENTOS")
          lines.push("  <provider>  nombre del provider")
          lines.push("  <modelo>    nombre del modelo")
          lines.push("")
          lines.push("  EJEMPLOS")
          lines.push("  /modelo set anthropic claude-sonnet-4-6")
        } else if (match === "/narrative search") {
          lines.push("  SINTAXIS")
          lines.push("  /narrative search <query>")
          lines.push("")
          lines.push("  ARGUMENTOS")
          lines.push("  <query>    texto a buscar (usa FTS5 con stemming)")
          lines.push("")
          lines.push("  EJEMPLOS")
          lines.push('  /narrative search JWT')
        } else {
          lines.push("  SINTAXIS")
          lines.push(`  ${match} [args]`)
          lines.push("")
          lines.push("  Usa sin argumentos para ver las subopciones disponibles.")
        }
        return lines.join("\n") + "\n"
      }
    }

    return `  comando no encontrado: ${topic}\n\n  Escribe /help para ver la lista completa\n`
  }

  const output: string[] = ["", "  Categor\u00edas:", ""]
  for (const [cat, info] of Object.entries(HELP_CATEGORIES)) {
    output.push(`  \u25b8 /${cat.padEnd(12)} ${info.desc}`)
  }
  output.push("")
  output.push("  Escribe: /help <comando>  para detalles")
  output.push("  Ejemplo: /help /provider set")
  output.push("")
  return output.join("\n")
}

async function handleProviderCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
  ctx: ContextState,
  ui?: UiCallbacks,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 list      \u2014 muestra providers + modelo activo",
        "  \u00b7 add       \u2014 agregar nuevo provider",
        "  \u00b7 set       \u2014 cambiar provider activo",
        "  \u00b7 test      \u2014 ping al provider",
        "  \u00b7 status    \u2014 estado de todos",
        "",
      ].join("\n"),
      menu: [
        { label: "list",   cmd: "/provider list",   desc: "muestra providers + modelo activo" },
        { label: "add",    cmd: "/provider add",    desc: "agregar nuevo provider" },
        { label: "set",    cmd: "/provider set",    desc: "cambiar provider activo" },
        { label: "test",   cmd: "/provider test",   desc: "ping al provider" },
        { label: "status", cmd: "/provider status", desc: "estado de todos" },
      ],
    }
  }

  switch (action) {
    case "list": {
      const providers = db.query(
        "SELECT * FROM providers ORDER BY CASE WHEN enabled = 1 THEN 0 ELSE 1 END, name"
      ).all() as ProviderRow[]
      const modelRows = db.query(
        "SELECT key, value FROM code_config WHERE key LIKE 'provider_model_%'"
      ).all() as { key: string; value: string }[]
      const modelMap = new Map(modelRows.map(r => [r.key.replace("provider_model_", ""), r.value]))
      return { handled: true, output: renderProviderList(providers, ctx.activeProvider, modelMap) }
    }
    case "add": {
      // Inline modal if available
      if (ui?.showConfigModal) {
        const values = await ui.showConfigModal("provider_add", "Agregar Provider", [
          { key: "id",       label: "ID del Provider", placeholder: "openai",                     required: true,  secret: false, field_type: "text" },
          { key: "name",     label: "Nombre",           placeholder: "OpenAI",                     required: true,  secret: false, field_type: "text" },
          { key: "api_key",  label: "API Key",          placeholder: "sk-\u2026",                       required: true,  secret: true,  field_type: "text" },
          { key: "base_url", label: "Base URL",         placeholder: "https://api.openai.com/v1", required: false, secret: false, field_type: "text" },
          { key: "category", label: "Categor\u00eda",        placeholder: "",                           required: false, secret: false, field_type: "select", options: ["llm", "stt", "tts"] },
        ])
        if (!values) return { handled: true, output: "  Configuraci\u00f3n cancelada" }
        const providerId = values.id.trim().toLowerCase()
        await storeProviderApiKey(providerId, values.api_key)
        db.query(`
          INSERT INTO providers (id, name, base_url, enabled, category)
          VALUES (?,?,?,1,?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            base_url = excluded.base_url,
            enabled = 1,
            category = excluded.category
        `).run(
          providerId,
          values.name || providerId,
          values.base_url || null,
          values.category || "llm",
        )
        db.query("INSERT OR REPLACE INTO code_config (key,value) VALUES ('default_provider',?)").run(providerId)
        return {
          handled: true,
          output: `  \u2713 Provider ${providerId} configurado`,
          newState: { activeProvider: providerId },
        }
      }
      // Fallback: wizard if available, else non-interactive
      if (ui?.suspendTui && ui?.resumeTui && ui?.runProviderSetupWizard) {
        const known = (db.query("SELECT id FROM providers ORDER BY id").all() as { id: string }[]).map(r => r.id)
        await ui.suspendTui()
        try {
          const result = await ui.runProviderSetupWizard(known, VERSION)
          if (result) {
            await storeProviderApiKey(result.provider, result.apiKey)
            db.query(`
              INSERT INTO providers (id, name, base_url, enabled)
              VALUES (?,?,?,1)
              ON CONFLICT(id) DO UPDATE SET
                base_url = excluded.base_url,
                enabled = 1
            `).run(result.provider, result.provider, result.baseUrl || null)
            db.query("INSERT OR REPLACE INTO code_config (key,value) VALUES ('default_provider',?)").run(result.provider)
            if (result.model) {
              db.query("INSERT OR REPLACE INTO code_config (key,value) VALUES (?,?)").run(`provider_model_${result.provider}`, result.model)
            }
            return {
              handled: true,
              output: `  \u2713 Provider ${result.provider} configurado`,
              newState: { activeProvider: result.provider, activeModel: result.model || "" },
            }
          }
          return { handled: true, output: "  Configuraci\u00f3n cancelada" }
        } finally {
          ui.resumeTui()
        }
      }
      const name = rest[0]
      if (!name) return {
        handled: true,
        output: "uso: /provider add <nombre>\nejemplos: /provider add openai",
      }
      const existing = db.query("SELECT id FROM providers WHERE id = ?").get(name) as any
      if (existing) {
        return { handled: true, output: `  ${name} ya existe. Usa /provider set ${name} para activarlo.` }
      }
      db.query("INSERT OR IGNORE INTO providers (id, name, enabled) VALUES (?, ?, 1)").run(name, name)
      return {
        handled: true,
        output: `  \u2713 ${name} agregado\n\n  Configurar API key con: hivecode secret set provider.${name}\n  Activar con: /provider set ${name}`,
      }
    }
    case "set": {
      if (ui?.showConfigModal) {
        // Muestra TODOS los providers LLM \u2014 con y sin API key
        const allProviders = db.query(
          "SELECT id, name FROM providers WHERE category = 'llm' OR category IS NULL ORDER BY name"
        ).all() as { id: string; name: string }[]

        if (allProviders.length === 0) {
          return { handled: true, output: "  No hay providers registrados.\n  Agrega uno con: /provider add" }
        }

        // Marca los que ya tienen clave vs los que necesitan configuraci\u00f3n
        const providerStates = await Promise.all(allProviders.map(async p => ({
          ...p,
          hasApiKey: await hasProviderApiKey(p.id),
        })))
        const options = providerStates.map(p =>
          p.hasApiKey ? p.id : `${p.id}  (sin clave)`
        )
        const rawIds = allProviders.map(p => p.id)
        const current = rawIds.includes(ctx.activeProvider) ? ctx.activeProvider : rawIds[0]

        const values = await ui.showConfigModal("provider_set", "Activar Provider", [
          {
            key: "provider",
            label: "Selecciona provider",
            placeholder: current,
            required: true,
            secret: false,
            field_type: "select",
            options,
            default_value: current,
          },
          {
            key: "api_key",
            label: "API Key  (vac\u00edo si ya est\u00e1 configurada)",
            placeholder: "sk-\u2026 / tu-api-key",
            required: false,
            secret: true,
            field_type: "text",
          },
        ])

        if (!values) return { handled: true, output: "  Cancelado" }

        // El valor seleccionado puede tener el sufijo "  (sin clave)" \u2014 extraer id real
        const rawSelected = values.provider || current
        const selectedId = rawSelected.replace(/\s+\(sin clave\)$/, "").trim()

        const providerRow = providerStates.find(p => p.id === selectedId)
        const newKey = values.api_key?.trim() || ""
        const existingKey = providerRow?.hasApiKey ?? false

        if (!newKey && !existingKey) {
          return {
            handled: true,
            output: `  \u26a0 ${selectedId} no tiene API key.\n  Ingresa la clave en el campo "API Key" y vuelve a intentarlo.`,
          }
        }

        if (newKey) {
          await storeProviderApiKey(selectedId, newKey)
        }
        db.query("UPDATE providers SET enabled = 1 WHERE id = ?").run(selectedId)
        db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_provider', ?)").run(selectedId)

        // Cambiar al primer modelo del nuevo provider para evitar 401 por modelo incompatible
        const firstModel = db.query(
          "SELECT id FROM models WHERE provider = ? ORDER BY id ASC LIMIT 1"
        ).get(selectedId) as { id: string } | null
        const newModel = firstModel?.id ?? null
        if (newModel) {
          db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_model', ?)").run(newModel)
        }

        const verb = newKey ? "configurado y activado" : "activado"
        const modelLine = newModel ? `\n  Modelo: ${newModel}` : ""
        return {
          handled: true,
          output: `  \u2b22 Provider ${selectedId} ${verb}${modelLine}`,
          newState: { activeProvider: selectedId, ...(newModel && { activeModel: newModel }) },
        }
      }

      // Sin modal (modo texto puro)
      const name = rest[0]
      if (!name) {
        const providers = db.query("SELECT id FROM providers ORDER BY id").all() as { id: string }[]
        return {
          handled: true,
          output: "uso: /provider set <nombre>\ndisponibles: " + providers.map(p => p.id).join(", "),
        }
      }
      const row = db.query("SELECT id FROM providers WHERE id = ?").get(name) as any
      if (!row) return { handled: true, output: `  Provider no encontrado: ${name}\n  Agrega con: /provider add ${name}` }
      db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_provider', ?)").run(name)
      return {
        handled: true,
        output: `  \u2b22 Provider: ${name}`,
        newState: { activeProvider: name },
      }
    }
    case "test": {
      const name = rest[0] || ctx.activeProvider
      if (!name) return { handled: true, output: "  No hay provider activo para probar." }
      try {
        const start = performance.now()
        const row = db.query("SELECT base_url FROM providers WHERE id = ?").get(name) as any
        const baseUrl = row?.base_url || "https://api.anthropic.com"
        await fetch(`${baseUrl}/v1/models`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000),
        })
        const latency = Math.round(performance.now() - start)
        return { handled: true, output: `  \u2713 ${name} respondi\u00f3 en ${latency}ms` }
      } catch (err) {
        return { handled: true, output: `  \u2717 ${name} no responde: ${(err as Error).message}` }
      }
    }
    case "status": {
      const providers = db.query("SELECT * FROM providers").all() as ProviderRow[]
      const lines = providers.map(p => {
        const icon = p.enabled ? "\u25cf" : "\u25cb"
        const active = p.id === ctx.activeProvider ? " [ACTIVO]" : ""
        return `  ${icon}  ${p.name}${active}`
      })
      return {
        handled: true,
        output: ["", ...lines, ""].join("\n") || "  No hay providers configurados.\n",
      }
    }
    default:
      return { handled: true, output: "opciones: list | add | set | test | status\n\nEscribe /help /provider" }
  }
}

interface ModelRow {
  id: string
  provider_id: string
  name: string
  model_type: string
  context_window: number
  enabled: number
}

async function handleModelCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
  ctx: ContextState,
  ui?: UiCallbacks,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 list      \u2014 lista modelos guardados en BD",
        "  \u00b7 set       \u2014 cambia modelo activo",
        "  \u00b7 add       \u2014 agrega modelo a la BD",
        "  \u00b7 delete    \u2014 elimina modelo de la BD",
        "  \u00b7 info      \u2014 detalles del modelo activo",
        "",
      ].join("\n"),
      menu: [
        { label: "list",   cmd: "/modelo list",   desc: "lista modelos guardados en BD" },
        { label: "set",    cmd: "/modelo set",    desc: "cambia modelo activo" },
        { label: "add",    cmd: "/modelo add",    desc: "agrega modelo a la BD" },
        { label: "delete", cmd: "/modelo delete", desc: "elimina modelo de la BD" },
        { label: "info",   cmd: "/modelo info",   desc: "detalles del modelo activo" },
      ],
    }
  }

  switch (action) {
    case "list": {
      const providerId = rest[0] || ctx.activeProvider
      const activeModel = ctx.activeModel
      const rows = providerId
        ? (db.query("SELECT * FROM models WHERE provider_id = ? AND enabled = 1 ORDER BY name").all(providerId) as ModelRow[])
        : (db.query("SELECT * FROM models WHERE enabled = 1 ORDER BY provider_id, name").all() as ModelRow[])

      if (rows.length === 0) {
        return {
          handled: true,
          output: [
            "",
            providerId ? `  Sin modelos para ${providerId}.` : "  Sin modelos en la BD.",
            "  Agrega con: /modelo add",
            "",
          ].join("\n"),
        }
      }

      const lines: string[] = ["", `  Modelos${providerId ? ` (${providerId})` : ""}:`, ""]
      for (const m of rows) {
        const isActive = m.id === activeModel
        const tag = isActive ? " [ACTIVO]" : ""
        const prefix = isActive ? "\u25b8" : "\u00b7"
        lines.push(`  ${prefix} ${m.id.padEnd(32)} ${m.model_type.padEnd(10)} ctx:${m.context_window}${tag}`)
      }
      lines.push("")
      lines.push("  Cambiar con: /modelo set")
      lines.push("")
      return { handled: true, output: lines.join("\n") }
    }

    case "set": {
      if (ui?.showConfigModal) {
        const enabledProviders = db.query(
          "SELECT id FROM providers WHERE enabled = 1 ORDER BY id"
        ).all() as { id: string }[]
        const providers = (await Promise.all(enabledProviders.map(async p => ({
          ...p,
          hasApiKey: await hasProviderApiKey(p.id),
        })))).filter(p => p.hasApiKey)
        if (providers.length === 0) {
          return { handled: true, output: "  No hay providers con API key configurada. Agrega uno con: /provider add" }
        }
        // Build combined options: "provider :: modelId" — solo providers con API key
        const providerIds = new Set(providers.map(p => p.id))
        const dbModels = (db.query(`
          SELECT m.id, m.provider_id
          FROM models m
          JOIN providers p ON m.provider_id = p.id
          WHERE m.enabled = 1
            AND p.enabled = 1
          ORDER BY m.provider_id, m.id
        `).all() as { id: string; provider_id: string }[]).filter(m => providerIds.has(m.provider_id))

        const combinedOptions = dbModels.map(m => `${m.provider_id} :: ${m.id}`)

        // Fields: if models exist in BD, use select; else text
        const currentCombo = ctx.activeProvider && ctx.activeModel
          ? `${ctx.activeProvider} :: ${ctx.activeModel}`
          : undefined
        const defaultCombo = currentCombo && combinedOptions.includes(currentCombo) ? currentCombo : combinedOptions[0]

        const fields: ModalField[] = combinedOptions.length > 0
          ? [
              { key: "combo", label: "Provider :: Modelo", placeholder: "", required: true, secret: false, field_type: "select", options: combinedOptions, default_value: defaultCombo },
            ]
          : [
              { key: "provider", label: "Provider",  placeholder: ctx.activeProvider || providers[0].id, required: true,  secret: false, field_type: "select", options: providers.map(p => p.id), default_value: ctx.activeProvider || undefined },
              { key: "model",    label: "Modelo ID", placeholder: "claude-sonnet-4-6",                   required: true,  secret: false, field_type: "text" },
            ]

        const values = await ui.showConfigModal("model_set", "Cambiar Modelo Activo", fields)
        if (!values) return { handled: true, output: "  Cancelado" }

        let providerId: string
        let modelId: string
        if (values.combo) {
          const parts = values.combo.split(" :: ")
          providerId = parts[0]?.trim() ?? ctx.activeProvider
          modelId    = parts[1]?.trim() ?? ""
        } else {
          providerId = values.provider || ctx.activeProvider
          modelId    = values.model || ""
        }
        if (!modelId) return { handled: true, output: "  Modelo no especificado" }
        db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)").run(`provider_model_${providerId}`, modelId)
        db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_provider', ?)").run(providerId)
        return {
          handled: true,
          output: `  \u2b22 Modelo: ${modelId}  [${providerId}]`,
          newState: { activeProvider: providerId, activeModel: modelId },
        }
      }
      // Non-modal fallback
      const provider = rest[0] || ctx.activeProvider
      const model = rest[1]
      if (!model) {
        const rows = db.query("SELECT id FROM models WHERE provider_id = ? AND enabled = 1 ORDER BY id").all(provider) as { id: string }[]
        const hint = rows.length > 0 ? rows.map(r => r.id).join(", ") : "(ninguno en BD)"
        return {
          handled: true,
          output: `uso: /modelo set <provider> <modelo>\nDisponibles para ${provider}: ${hint}`,
        }
      }
      db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)").run(`provider_model_${provider}`, model)
      return {
        handled: true,
        output: `  \u2b22 Modelo: ${model} [${provider}]`,
        newState: { activeModel: model },
      }
    }

    case "add": {
      if (ui?.showConfigModal) {
        const providers = db.query("SELECT id FROM providers WHERE enabled = 1 ORDER BY id").all() as { id: string }[]
        if (providers.length === 0) {
          return { handled: true, output: "  No hay providers configurados. Agrega uno con: /provider add" }
        }
        const values = await ui.showConfigModal("model_add", "Agregar Modelo", [
          { key: "id",             label: "ID del modelo",    placeholder: "claude-sonnet-4-6",     required: true,  secret: false, field_type: "text" },
          { key: "name",           label: "Nombre",           placeholder: "Claude Sonnet 4.6",     required: true,  secret: false, field_type: "text" },
          { key: "provider_id",    label: "Provider",         placeholder: "",                      required: true,  secret: false, field_type: "select", options: providers.map(p => p.id) },
          { key: "model_type",     label: "Tipo",             placeholder: "",                      required: false, secret: false, field_type: "select", options: ["llm", "stt", "tts", "vision", "embedding"] },
          { key: "context_window", label: "Ventana contexto", placeholder: "200000",                required: false, secret: false, field_type: "text" },
        ])
        if (!values) return { handled: true, output: "  Cancelado" }
        const modelId     = values.id.trim()
        const modelName   = values.name || modelId
        const providerId  = values.provider_id
        const modelType   = values.model_type || "llm"
        const ctxWindow   = parseInt(values.context_window || "20000", 10) || 20000
        db.query(`
          INSERT INTO models (id, provider_id, name, model_type, context_window, enabled)
          VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            provider_id    = excluded.provider_id,
            name           = excluded.name,
            model_type     = excluded.model_type,
            context_window = excluded.context_window,
            enabled        = 1
        `).run(modelId, providerId, modelName, modelType, ctxWindow)
        return {
          handled: true,
          output: `  \u2713 Modelo ${modelId} (${modelType}) agregado a ${providerId}`,
        }
      }
      // Non-modal fallback
      const [modelId, providerId] = rest
      if (!modelId || !providerId) {
        return { handled: true, output: "uso: /modelo add <id> <provider>\nejemplo: /modelo add claude-sonnet-4-6 anthropic" }
      }
      db.query("INSERT OR IGNORE INTO models (id, provider_id, name, model_type) VALUES (?,?,?,?)")
        .run(modelId, providerId, modelId, "llm")
      return { handled: true, output: `  \u2713 Modelo ${modelId} agregado a ${providerId}` }
    }

    case "delete":
    case "remove": {
      if (ui?.showConfigModal) {
        const rows = db.query("SELECT id, provider_id FROM models WHERE enabled = 1 ORDER BY provider_id, id").all() as { id: string; provider_id: string }[]
        if (rows.length === 0) return { handled: true, output: "  No hay modelos en la BD." }
        const options = rows.map(m => `${m.provider_id} :: ${m.id}`)
        const values = await ui.showConfigModal("model_delete", "Eliminar Modelo", [
          { key: "combo", label: "Modelo a eliminar", placeholder: "", required: true, secret: false, field_type: "select", options },
        ])
        if (!values) return { handled: true, output: "  Cancelado" }
        const parts = values.combo.split(" :: ")
        const modelId = parts[1]?.trim()
        if (!modelId) return { handled: true, output: "  Selecci\u00f3n inv\u00e1lida" }
        db.query("DELETE FROM models WHERE id = ?").run(modelId)
        return { handled: true, output: `  \u2713 Modelo ${modelId} eliminado` }
      }
      const modelId = rest[0]
      if (!modelId) return { handled: true, output: "uso: /modelo delete <id>" }
      db.query("DELETE FROM models WHERE id = ?").run(modelId)
      return { handled: true, output: `  \u2713 Modelo ${modelId} eliminado` }
    }

    case "info": {
      const modelId = rest[0] || ctx.activeModel
      const row = modelId
        ? (db.query("SELECT * FROM models WHERE id = ?").get(modelId) as ModelRow | undefined)
        : undefined
      if (!row) {
        return {
          handled: true,
          output: [
            "",
            `  Modelo activo: ${ctx.activeModel || "(ninguno)"}`,
            `  Provider: ${ctx.activeProvider || "(ninguno)"}`,
            "  (sin entrada en BD \u2014 agrega con /modelo add)",
            "",
          ].join("\n"),
        }
      }
      return {
        handled: true,
        output: [
          "",
          `  ID:              ${row.id}`,
          `  Nombre:          ${row.name}`,
          `  Provider:        ${row.provider_id}`,
          `  Tipo:            ${row.model_type}`,
          `  Ventana contexto: ${row.context_window.toLocaleString()} tokens`,
          "",
        ].join("\n"),
      }
    }

    default:
      return { handled: true, output: "opciones: list | set | add | delete | info\n\nEscribe /help /modelo" }
  }
}

async function handleMcpCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
  ctx: ContextState,
  ui?: UiCallbacks,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 list      \u2014 lista MCPs conectados/desconectados",
        "  \u00b7 add       \u2014 registra nuevo MCP",
        "  \u00b7 enable    \u2014 activa MCP en sesi\u00f3n actual",
        "  \u00b7 disable   \u2014 desactiva sin eliminar config",
        "  \u00b7 test      \u2014 verifica conexi\u00f3n y lista tools",
        "",
      ].join("\n"),
      menu: [
        { label: "list",    cmd: "/mcp list",    desc: "lista MCPs conectados/desconectados" },
        { label: "add",     cmd: "/mcp add",     desc: "registra nuevo MCP" },
        { label: "enable",  cmd: "/mcp enable",  desc: "activa MCP en sesi\u00f3n actual" },
        { label: "disable", cmd: "/mcp disable", desc: "desactiva sin eliminar config" },
        { label: "test",    cmd: "/mcp test",    desc: "verifica conexi\u00f3n y lista tools" },
      ],
    }
  }

  switch (action) {
    case "list": {
      const rows = db.query("SELECT id, name, transport, url, command, enabled, status, tools_count FROM mcp_servers ORDER BY id").all() as any[]
      if (rows.length === 0) {
        return { handled: true, output: "\n  No hay servidores MCP configurados.\n  Agrega uno con: /mcp add <url-o-nombre>\n" }
      }
      const lines = rows.map(r => {
        const icon = r.enabled ? "\u25cf" : "\u25cb"
        const status = r.status || "unknown"
        const tools = r.tools_count ? ` (${r.tools_count} tools)` : ""
        const endpoint = r.url || r.command || ""
        return `  ${icon} ${r.id.padEnd(18)} ${r.transport.padEnd(6)} ${status.padEnd(12)}${endpoint}${tools}`
      })
      return { handled: true, output: "\n  Servidores MCP:\n\n" + lines.join("\n") + "\n" }
    }
    case "add": {
      if (ui?.showConfigModal) {
        const values = await ui.showConfigModal("mcp_add", "Agregar Servidor MCP", [
          { key: "id", label: "ID del servidor", placeholder: "my-mcp-server", required: true, secret: false, field_type: "text" },
          { key: "name", label: "Nombre", placeholder: "My MCP Server", required: true, secret: false, field_type: "text" },
          { key: "transport", label: "Transporte", placeholder: "", required: true, secret: false, field_type: "select", options: ["sse", "stdio", "http"] },
          { key: "url", label: "URL (SSE/HTTP)", placeholder: "http://localhost:3000/sse", required: false, secret: false, field_type: "text" },
          { key: "command", label: "Comando (STDIO)", placeholder: "npx -y @modelcontextprotocol/server-filesystem", required: false, secret: false, field_type: "text" },
        ])
        if (!values) return { handled: true, output: "  Configuraci\u00f3n cancelada" }
        const id = values.id.trim().toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "_")
        const transport = values.transport || "sse"
        const url = values.url || null
        const command = values.command || null
        db.query(`
          INSERT OR REPLACE INTO mcp_servers (id, name, transport, url, command, enabled, active, builtin, status)
          VALUES (?, ?, ?, ?, ?, 1, 0, 0, 'disconnected')
        `).run(id, values.name || id, transport, url, command)
        return { handled: true, output: `  \u2713 MCP ${id} a\u00f1adido (${transport})\n  El hot-reload lo conectar\u00e1 autom\u00e1ticamente.` }
      }
      const input = rest[0]
      if (!input) return { handled: true, output: "uso: /mcp add <url-o-nombre>\nejemplo: /mcp add http://localhost:3000/sse" }
      const id = input.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()
      const isUrl = input.startsWith("http://") || input.startsWith("https://")
      const transport = isUrl ? "sse" : "stdio"
      db.query(`
        INSERT OR REPLACE INTO mcp_servers (id, name, transport, url, command, enabled, active, builtin, status)
        VALUES (?, ?, ?, ?, ?, 1, 0, 0, 'disconnected')
      `).run(id, input, transport, isUrl ? input : null, isUrl ? null : input)
      return { handled: true, output: `  \u2713 MCP ${id} a\u00f1adido (${transport})\n  El hot-reload lo conectar\u00e1 autom\u00e1ticamente.` }
    }
    case "enable": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /mcp enable <nombre>" }
      db.query("UPDATE mcp_servers SET enabled = 1 WHERE id = ?").run(name)
      return { handled: true, output: `  \u2713 MCP ${name} habilitado` }
    }
    case "disable": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /mcp disable <nombre>" }
      db.query("UPDATE mcp_servers SET enabled = 0 WHERE id = ?").run(name)
      return { handled: true, output: `  \u2713 MCP ${name} deshabilitado` }
    }
    case "test": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /mcp test <nombre>" }
      const row = db.query("SELECT id, url, transport FROM mcp_servers WHERE id = ?").get(name) as any
      if (!row) return { handled: true, output: `  MCP no encontrado: ${name}` }
      try {
        if (row.transport === "sse" && row.url) {
          const response = await fetch(row.url, { method: "GET" })
          return { handled: true, output: response.ok
            ? `  \u2713 ${name} responde correctamente`
            : `  \u2717 ${name} error HTTP ${response.status}`
          }
        }
        return { handled: true, output: `  ${name} es STDIO — requiere verificaci\u00f3n manual` }
      } catch (err) {
        return { handled: true, output: `  \u2717 ${name} no responde: ${(err as Error).message}` }
      }
    }
    case "load": {
      const filePath = rest[0]
      if (!filePath) return { handled: true, output: "uso: /mcp load <path>\nejemplo: /mcp load ./mcp.json" }
      try {
        const content = await Bun.file(filePath).text()
        const config = JSON.parse(content)
        const servers = config.mcpServers || config.servers || {}
        let added = 0
        for (const [name, srv] of Object.entries(servers) as [string, any][]) {
          const id = name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()
          const isUrl = srv.url && (srv.url.startsWith("http://") || srv.url.startsWith("https://"))
          const transport = isUrl ? "sse" : (srv.transport || "stdio")
          const url = isUrl ? srv.url : null
          const command = !isUrl && srv.command ? srv.command : null
          const args = srv.args ? JSON.stringify(srv.args) : null
          db.query(`
            INSERT OR REPLACE INTO mcp_servers (id, name, transport, url, command, args, enabled, active, builtin, status)
            VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, 'disconnected')
          `).run(id, name, transport, url, command, args)
          added++
        }
        return { handled: true, output: `  \u2713 ${added} servidores MCP cargados desde ${filePath}` }
      } catch (err) {
        return { handled: true, output: `  \u2717 Error cargando MCP config: ${(err as Error).message}` }
      }
    }
    default:
      return { handled: true, output: "opciones: list | add | enable | disable | test\n\nEscribe /help /mcp" }
  }
}

async function handleSkillCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 list      \u2014 lista skills: built-in / custom / active",
        "  \u00b7 enable    \u2014 activa skill",
        "  \u00b7 disable   \u2014 desactiva sin eliminar",
        "  \u00b7 info      \u2014 muestra contenido y metadata",
        "  \u00b7 add       \u2014 importa skill desde archivo .md",
        "",
      ].join("\n"),
      menu: [
        { label: "list",    cmd: "/skill list",    desc: "lista skills: built-in / custom / active" },
        { label: "enable",  cmd: "/skill enable",  desc: "activa skill" },
        { label: "disable", cmd: "/skill disable", desc: "desactiva sin eliminar" },
        { label: "info",    cmd: "/skill info",    desc: "muestra contenido y metadata" },
        { label: "add",     cmd: "/skill add",     desc: "importa skill desde archivo .md" },
      ],
    }
  }

  switch (action) {
    case "list": {
      const rows = db.query("SELECT id, name, active, category FROM skills ORDER BY id").all() as any[]
      if (rows.length === 0) return { handled: true, output: "\n  No hay skills registradas.\n" }
      const lines = rows.map(r => {
        const icon = r.active ? "\u25cf" : "\u25cb"
        return `  ${icon}  ${r.id.padEnd(25)} ${r.category || "general"}`
      })
      return { handled: true, output: "\n" + lines.join("\n") + "\n" }
    }
    case "enable": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /skill enable <nombre>" }
      db.query("UPDATE skills SET active = 1 WHERE id = ?").run(name)
      return { handled: true, output: `  \u2713 Skill ${name} habilitada` }
    }
    case "disable": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /skill disable <nombre>" }
      db.query("UPDATE skills SET active = 0 WHERE id = ?").run(name)
      return { handled: true, output: `  \u2713 Skill ${name} deshabilitada` }
    }
    case "info": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /skill info <nombre>" }
      const row = db.query("SELECT * FROM skills WHERE id = ?").get(name) as any
      if (!row) return { handled: true, output: `  Skill no encontrada: ${name}` }
      const preview = row.body ? row.body.slice(0, 300).replace(/\n/g, "\n  │    ") : "N/A"
      return {
        handled: true,
        output: [
          "",
          `  ID:          ${row.id}`,
          `  Nombre:      ${row.name || row.id}`,
          `  Descripci\u00f3n: ${row.description || "N/A"}`,
          `  Categor\u00eda:   ${row.category || "N/A"}`,
          `  Habilitada:  ${row.active ? "S\u00ed" : "No"}`,
          "",
          `  Contenido:`,
          `  │    ${preview}...`,
          "",
        ].join("\n"),
      }
    }
    case "add": {
      const path = rest[0]
      if (!path) return { handled: true, output: "uso: /skill add <path>\nejemplo: /skill add ~/my-skills/custom_auth.md" }
      try {
        const content = await Bun.file(path).text()
        const nameMatch = content.match(/^#\s+(.+)/m)
        const skillName = nameMatch ? nameMatch[1].trim() : path.split("/").pop()?.replace(".md", "") || "custom"
        const id = skillName.toLowerCase().replace(/[^a-z0-9_-]/g, "_")
        db.query("INSERT OR REPLACE INTO skills (id, name, description, body, active, category) VALUES (?, ?, ?, ?, 1, 'custom')")
          .run(id, skillName, `Imported from ${path}`, content)
        return { handled: true, output: `  \u2713 Skill ${id} agregada desde ${path}` }
      } catch (err) {
        return { handled: true, output: `  \u2717 Error: ${(err as Error).message}` }
      }
    }
    default:
      return { handled: true, output: "opciones: list | enable | disable | info | add\n\nEscribe /help /skill" }
  }
}

async function handleModeCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
  ctx: ContextState,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 get       \u2014 muestra modo actual",
        "  \u00b7 set       \u2014 cambiar modo",
        "  \u00b7 history   \u2014 historial de cambios",
        "",
      ].join("\n"),
      menu: [
        { label: "get",     cmd: "/mode get",     desc: "muestra modo actual" },
        { label: "set",     cmd: "/mode set",     desc: "cambiar modo (plan|approval|auto)" },
        { label: "history", cmd: "/mode history", desc: "historial de cambios" },
      ],
    }
  }

  switch (action) {
    case "get":
      return { handled: true, output: `\n  Modo actual: ${ctx.activeMode.toUpperCase()}\n` }
    case "set": {
      const mode = rest[0]
      if (!mode || !["plan", "approval", "auto"].includes(mode)) {
        return { handled: true, output: "uso: /mode set <plan|approval|auto>" }
      }
      db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_mode', ?)").run(mode)
      return {
        handled: true,
        output: `  \u2b22 Modo cambiado a: ${mode.toUpperCase()}`,
        newState: { activeMode: mode as "plan" | "approval" | "auto" },
      }
    }
    case "history": {
      const rows = db.query(
        "SELECT mode, changed_at FROM code_session_modes ORDER BY id DESC LIMIT 10"
      ).all() as { mode: string; changed_at: string }[]
      if (rows.length === 0) return { handled: true, output: "\n  No hay historial de cambios de modo.\n" }
      const lines = rows.map(r => `  \u00b7 ${r.mode.toUpperCase().padEnd(10)} ${r.changed_at}`)
      return { handled: true, output: "\n  Historial de cambios:\n\n" + lines.join("\n") + "\n" }
    }
    default:
      return { handled: true, output: "opciones: get | set | history\n\nEscribe /help /mode" }
  }
}

async function handleTaskCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 list      \u2014 tareas recientes",
        "  \u00b7 status    \u2014 estado detallado + fase actual",
        "  \u00b7 cancel    \u2014 cancela tarea en curso",
        "  \u00b7 rollback  \u2014 revierte cambios de una tarea",
        "",
      ].join("\n"),
      menu: [
        { label: "list",     cmd: "/task list",     desc: "tareas recientes" },
        { label: "status",   cmd: "/task status",   desc: "estado detallado + fase actual" },
        { label: "cancel",   cmd: "/task cancel",   desc: "cancela tarea en curso" },
        { label: "rollback", cmd: "/task rollback", desc: "revierte cambios de una tarea" },
      ],
    }
  }

  switch (action) {
    case "list": {
      const limit = Math.min(parseInt(rest[rest.indexOf("--limit") + 1] || "10", 10), 50)
      const rows = db.query(
        "SELECT id, description, status, created_at FROM code_tasks ORDER BY created_at DESC LIMIT ?"
      ).all(limit) as { id: string; description: string; status: string; created_at: string }[]
      if (rows.length === 0) return { handled: true, output: "\n  No hay tareas.\n" }
      const lines = rows.map(r => `  \u25b8 ${r.id.slice(0, 8).padEnd(10)} ${r.status.padEnd(12)} ${r.description.slice(0, 50)}`)
      return { handled: true, output: "\n" + lines.join("\n") + "\n" }
    }
    case "status": {
      const id = rest[0]
      if (!id) return { handled: true, output: "uso: /task status <id>" }
      const row = db.query("SELECT * FROM code_tasks WHERE id = ?").get(id) as any
      if (!row) return { handled: true, output: `  Tarea no encontrada: ${id}` }
      return {
        handled: true,
        output: [
          "",
          `  Tarea: ${row.id}`,
          `  Estado: ${row.status}`,
          `  Modo: ${row.mode || "N/A"}`,
          `  Rama: ${row.branch_name || "N/A"}`,
          `  Creada: ${row.created_at}`,
          "",
        ].join("\n"),
      }
    }
    case "cancel": {
      const id = rest[0]
      if (!id) return { handled: true, output: "uso: /task cancel <id>" }
      db.query("UPDATE code_tasks SET status = 'cancelled' WHERE id = ?").run(id)
      return { handled: true, output: `  \u2713 Tarea ${id.slice(0, 8)} cancelada` }
    }
    case "rollback": {
      const id = rest[0]
      if (!id) return { handled: true, output: "uso: /task rollback <id>" }
      try {
        const task = db.query("SELECT * FROM code_tasks WHERE id = ?").get(id) as any
        if (!task) return { handled: true, output: `  Tarea no encontrada: ${id}` }

        const snapshots = db.query("SELECT file_path, content FROM code_file_snapshots WHERE task_id = ?").all(id) as { file_path: string; content: string }[]
        if (snapshots.length === 0) {
          return { handled: true, output: `  No hay snapshots para la tarea ${id.slice(0, 8)}` }
        }

        let restored = 0
        for (const snap of snapshots) {
          try {
            await Bun.write(snap.file_path, snap.content)
            restored++
          } catch (e) {
            // skip files that can't be restored
          }
        }

        db.query("UPDATE code_tasks SET status = 'cancelled' WHERE id = ?").run(id)

        let gitMsg = ""
        if (task.branch_name) {
          try {
            const proc = Bun.spawn({
              cmd: ["git", "branch", "-D", task.branch_name],
              stdout: "pipe",
              stderr: "pipe",
              cwd: process.cwd(),
            })
            await proc.exited
            gitMsg = `\n  Rama ${task.branch_name} eliminada.`
          } catch {
            // ignore git errors
          }
        }

        return { handled: true, output: `  \u2713 Rollback completo: ${restored}/${snapshots.length} archivos restaurados.${gitMsg}` }
      } catch (err) {
        return { handled: true, output: `  \u2717 Error en rollback: ${(err as Error).message}` }
      }
    }
    default:
      return { handled: true, output: "opciones: list | status | cancel | rollback\n\nEscribe /help /task" }
  }
}

async function handleNarrativeCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 show      \u2014 muestra \u00faltimas N entradas",
        "  \u00b7 search    \u2014 busca en el narrativo por FTS5",
        "  \u00b7 export    \u2014 exporta narrativo completo",
        "",
      ].join("\n"),
      menu: [
        { label: "show",   cmd: "/narrative show",   desc: "muestra \u00faltimas N entradas" },
        { label: "search", cmd: "/narrative search", desc: "busca en el narrativo por FTS5" },
        { label: "export", cmd: "/narrative export", desc: "exporta narrativo completo" },
      ],
    }
  }

  switch (action) {
    case "show": {
      const lastIdx = rest.indexOf("--last")
      const limit = lastIdx !== -1 ? parseInt(rest[lastIdx + 1] || "5", 10) : 5
      const rows = db.query(
        "SELECT coordinator, entry, created_at FROM code_narrative ORDER BY id DESC LIMIT ?"
      ).all(limit) as { coordinator: string; entry: string; created_at: string }[]
      if (rows.length === 0) return { handled: true, output: "\n  No hay entradas en el narrativo.\n" }
      const lines = rows.map(r =>
        `  \u25b8 [${r.coordinator}] ${r.created_at}\n  │  ${r.entry.slice(0, 120)}`
      )
      return { handled: true, output: "\n" + lines.join("\n\n") + "\n" }
    }
    case "search": {
      const query = rest.join(" ")
      if (!query) return { handled: true, output: "uso: /narrative search <query>" }
      try {
        const rows = db.query(
          `SELECT coordinator, entry, created_at FROM code_narrative_fts
           WHERE code_narrative_fts MATCH ? ORDER BY rank LIMIT 5`
        ).all(query) as { coordinator: string; entry: string; created_at: string }[]
        if (rows.length === 0) return { handled: true, output: `\n  Sin resultados para: ${query}\n` }
        const lines = rows.map(r =>
          `  \u25b8 [${r.coordinator}] ${r.created_at}\n  │  ${r.entry.slice(0, 120)}`
        )
        return { handled: true, output: "\n" + lines.join("\n\n") + "\n" }
      } catch {
        return { handled: true, output: `  \u2717 Error en b\u00fasqueda FTS5.` }
      }
    }
    case "export": {
      const fmt = rest.includes("--format") ? rest[rest.indexOf("--format") + 1] || "md" : "md"
      const rows = db.query("SELECT * FROM code_narrative ORDER BY id").all() as any[]
      const content = rows.map(r =>
        `[${r.coordinator} — ${r.created_at}] [${r.task_id || "none"}] [${r.phase || ""}]\n\n${r.entry}\n\n---\n`
      ).join("\n")
      const outPath = `narrative-export-${Date.now()}.${fmt}`
      await Bun.write(outPath, content)
      return { handled: true, output: `  \u2713 Narrativo exportado a: ${outPath} (${rows.length} entradas)` }
    }
    default:
      return { handled: true, output: "opciones: show | search | export\n\nEscribe /help /narrative" }
  }
}

async function handleAceCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 status         \u2014 estado: trazas pendientes, \u00faltima reflexi\u00f3n",
        "  \u00b7 playbook list   \u2014 reglas aprendidas",
        "  \u00b7 playbook reset  \u2014 borra playbook",
        "  \u00b7 reflector run   \u2014 fuerza an\u00e1lisis inmediato",
        "",
      ].join("\n"),
    }
  }

  switch (action) {
    case "status": {
      const pending = (db.query("SELECT COUNT(*) as c FROM code_traces WHERE analyzed = 0").get() as any)?.c ?? 0
      const lastReflection = db.query(
        "SELECT insights, created_at FROM code_reflections ORDER BY id DESC LIMIT 1"
      ).get() as { insights: string; created_at: string } | undefined
      return {
        handled: true,
        output: [
          "",
          `  Trazas pendientes: ${pending}`,
          `  \u00daltima reflexi\u00f3n: ${lastReflection ? lastReflection.created_at : "ninguna"}`,
          lastReflection ? `  \u00daltimo insight: ${lastReflection.insights.slice(0, 100)}` : "",
          "",
        ].filter(Boolean).join("\n"),
      }
    }
    case "playbook": {
      if (rest[0] === "list") {
        const rows = db.query(
          "SELECT rule, confidence, active FROM code_playbook ORDER BY confidence DESC LIMIT 10"
        ).all() as { rule: string; confidence: number; active: number }[]
        if (rows.length === 0) return { handled: true, output: "\n  No hay reglas en el playbook.\n" }
        const lines = rows.map(r => {
          const icon = r.active ? "\u25cf" : "\u25cb"
          return `  ${icon}  [${(r.confidence * 100).toFixed(0)}%] ${r.rule.slice(0, 80)}`
        })
        return { handled: true, output: "\n" + lines.join("\n") + "\n" }
      }
      if (rest[0] === "reset") {
        db.query("DELETE FROM code_playbook").run()
        return { handled: true, output: "  \u2713 Playbook reiniciado" }
      }
      return { handled: true, output: "uso: /ace playbook list | /ace playbook reset" }
    }
    case "reflector": {
      if (rest[0] !== "run") {
        return { handled: true, output: "uso: /ace reflector run" }
      }
      try {
        const result = await runReflector(db)
        if (result.traces === 0) {
          return { handled: true, output: "  No hay trazas pendientes de an\u00e1lisis." }
        }
        return {
          handled: true,
          output: `  \u2713 Reflector: ${result.traces} trazas analizadas, ${result.rules} reglas generadas.`,
        }
      } catch (err) {
        return { handled: true, output: `  \u2717 Error en reflector: ${(err as Error).message}` }
      }
    }
    default:
      return { handled: true, output: "opciones: status | playbook | reflector\n\nEscribe /help /ace" }
  }
}

async function handleGithubCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
  ui?: UiCallbacks,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 connect    \u2014 conectar con GitHub (token PAT)",
        "  \u00b7 status      \u2014 verifica token v\u00e1lido y permisos",
        "  \u00b7 whoami      \u2014 muestra usuario autenticado",
        "  \u00b7 disconnect  \u2014 desconectar GitHub",
        "  \u00b7 set-repo    \u2014 vincula a repo espec\u00edfico",
        "",
      ].join("\n"),
      menu: [
        { label: "connect",    cmd: "/github connect",    desc: "conectar con GitHub (token PAT)" },
        { label: "status",     cmd: "/github status",     desc: "verifica token v\u00e1lido y permisos" },
        { label: "whoami",     cmd: "/github whoami",     desc: "muestra usuario autenticado" },
        { label: "disconnect", cmd: "/github disconnect", desc: "desconectar GitHub" },
        { label: "set-repo",   cmd: "/github set-repo",   desc: "vincula a repo espec\u00edfico" },
      ],
    }
  }

  switch (action) {
    case "connect": {
      if (ui?.showConfigModal) {
        const values = await ui.showConfigModal("github_connect", "Conectar GitHub", [
          { key: "token", label: "Personal Access Token", placeholder: "ghp_xxxxxxxxxxxx...", required: true, secret: true, field_type: "text" },
        ])
        if (!values) return { handled: true, output: "  Configuraci\u00f3n cancelada" }
        const token = values.token.trim()
        if (!token) return { handled: true, output: "  Token no proporcionado" }
        try {
          const res = await fetch("https://api.github.com/user", {
            headers: { Authorization: `Bearer ${token}`, "User-Agent": "hivecode" },
          })
          if (!res.ok) return { handled: true, output: "  \u2717 Token inv\u00e1lido o expirado" }
          const user = await res.json() as { login?: string }
          db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('github_token', ?)").run(token)
          return { handled: true, output: `  \u2713 GitHub conectado como ${user.login || "usuario"}` }
        } catch (err) {
          return { handled: true, output: `  \u2717 Error verificando token: ${(err as Error).message}` }
        }
      }
      return {
        handled: true,
        output: [
          "",
          "  Para conectar con GitHub:",
          "  1. Crea un Personal Access Token en:",
          "     https://github.com/settings/tokens",
          "  2. Ejecuta: hivecode secret set GITHUB_TOKEN",
          "",
        ].join("\n"),
      }
    }
    case "disconnect": {
      db.query("DELETE FROM code_config WHERE key = 'github_token'").run()
      return { handled: true, output: "  \u2713 GitHub desconectado" }
    }
    case "status": {
      const token = (db.query("SELECT value FROM code_config WHERE key = 'github_token'").get() as any)?.value
      return {
        handled: true,
        output: token
          ? "  \u2713 GitHub: token configurado"
          : "  \u2717 GitHub: no hay token. Configura con: hivecode github connect",
      }
    }
    case "whoami": {
      const token = (db.query("SELECT value FROM code_config WHERE key = 'github_token'").get() as any)?.value
      if (!token) return { handled: true, output: "  No hay token de GitHub configurado." }
      try {
        const res = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json() as { login?: string }
        return { handled: true, output: `  \u2713 GitHub: ${data.login || "desconocido"}` }
      } catch {
        return { handled: true, output: "  \u2717 No se pudo conectar con GitHub" }
      }
    }
    case "set-repo": {
      const repo = rest[0]
      if (!repo) return { handled: true, output: "uso: /github set-repo <owner/repo>\nejemplo: /github set-repo johpaz/mi-app" }
      db.query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_repo', ?)").run(repo)
      return { handled: true, output: `  \u2713 Repo vinculado: ${repo}` }
    }
    default:
      return { handled: true, output: "opciones: status | whoami | set-repo\n\nEscribe /help /github" }
  }
}

async function handleSessionCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
  ctx: ContextState,
): Promise<CommandResult> {
  const [action] = args
  if (!action || action === "new") {
    const projectPath = ctx.projectPath || process.cwd()
    const newId = Bun.randomUUIDv7()
    // Close current session if exists
    if (ctx.sessionId && ctx.sessionId !== "none") {
      db.query("UPDATE code_sessions SET status = 'closed', last_active = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(ctx.sessionId)
    }
    db.query("INSERT INTO code_sessions (id, project_path, status) VALUES (?, ?, 'active')").run(newId, projectPath)
    return {
      handled: true,
      output: `  \u2713 Nueva sesi\u00f3n: ${newId.slice(0, 8)}...`,
      newState: { sessionId: newId },
    }
  }
  return { handled: true, output: "opciones: new\n\nEscribe /session new" }
}

async function handleCompactCommand(
  db: ReturnType<typeof getDb>,
  ctx: ContextState,
): Promise<CommandResult> {
  const sessionId = ctx.sessionId
  if (!sessionId || sessionId === "none") {
    return { handled: true, output: "  No hay sesi\u00f3n activa para compactar." }
  }

  const rows = db.query(
    "SELECT id, user_message, agent_response FROM code_turns WHERE session_id = ? AND completed_at IS NOT NULL ORDER BY created_at"
  ).all(sessionId) as { id: string; user_message: string; agent_response: string }[]

  if (rows.length <= 10) {
    return { handled: true, output: `  Solo hay ${rows.length} turnos — no es necesario compactar.` }
  }

  try {
    const transcript = rows.map((r, i) => `Turno ${i + 1}:\nUsuario: ${r.user_message.slice(0, 200)}\nAgente: ${r.agent_response.slice(0, 200)}`).join("\n\n")
    const providerCfg = await resolveProviderConfig("openai", "gpt-4o-mini")
    const summaryResponse = await callLLM({
      ...providerCfg,
      messages: [
        {
          role: "system",
          content: "Resume la siguiente conversación en 3-5 oraciones, preservando decisiones importantes, preferencias del usuario y contexto necesario para continuar.",
        },
        { role: "user", content: transcript },
      ],
    })

    const summary = summaryResponse.content.trim()
    db.query(`
      INSERT INTO summaries (thread_id, summary, messages_covered, last_message_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        summary = excluded.summary,
        messages_covered = excluded.messages_covered,
        last_message_id = excluded.last_message_id,
        updated_at = unixepoch()
    `).run(sessionId, summary, rows.length, rows[rows.length - 1].id)

    return {
      handled: true,
      output: `  \u2713 Conversaci\u00f3n compactada: ${rows.length} turnos \u2192 resumen.\n  Resumen: ${summary.slice(0, 150)}...`,
    }
  } catch (err) {
    return { handled: true, output: `  \u2717 Error al compactar: ${(err as Error).message}` }
  }
}

async function handleNoteCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
  ctx: ContextState,
): Promise<CommandResult> {
  const [action, key, ...valueParts] = args
  const sessionId = ctx.sessionId || "default"

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 add <key> <value>  \u2014 agregar nota",
        "  \u00b7 list                 \u2014 listar notas",
        "  \u00b7 delete <key>         \u2014 eliminar nota",
        "",
      ].join("\n"),
    }
  }

  if (action === "add") {
    if (!key || valueParts.length === 0) {
      return { handled: true, output: "uso: /note add <key> <value>\nejemplo: /note add preferencia 'usar zod'" }
    }
    const value = valueParts.join(" ")
    const isAce = value.startsWith("@ace:")
    const cleanValue = isAce ? value.slice(5).trim() : value
    saveScratchpadNote(sessionId, key, cleanValue, isAce ? "user-ace" : "user")

    if (isAce) {
      // Propose as playbook rule with low confidence
      try {
        db.query(`
          INSERT INTO code_playbook (rule, confidence, active, coordinator, source)
          VALUES (?, 0.3, 1, NULL, 'user-note')
          ON CONFLICT(rule) DO UPDATE SET confidence = MIN(code_playbook.confidence + 0.05, 0.95)
        `).run(cleanValue)
      } catch { /* ignore duplicate errors */ }
    }

    return { handled: true, output: `  \u2713 Nota guardada: ${key}${isAce ? " (propuesta a ACE)" : ""}` }
  }

  if (action === "list") {
    const notes = getScratchpad(sessionId)
    if (notes.length === 0) return { handled: true, output: "  No hay notas guardadas." }
    const lines = notes.map(n => `  \u25b8 ${n.key}: ${n.value.slice(0, 60)}`)
    return { handled: true, output: "\n  Notas:\n\n" + lines.join("\n") + "\n" }
  }

  if (action === "delete") {
    if (!key) return { handled: true, output: "uso: /note delete <key>" }
    deleteScratchpadNote(sessionId, key)
    return { handled: true, output: `  \u2713 Nota eliminada: ${key}` }
  }

  return { handled: true, output: "opciones: add | list | delete\n\nEscribe /help /note" }
}

async function handleLogsCommand(
  args: string[],
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action || action === "list" || action === "show") {
    const level = (rest.find(a => ["debug", "info", "warn", "error"].includes(a.toLowerCase()))?.toLowerCase() || undefined) as any
    const coordinator = rest.find(a => a.startsWith("@"))?.slice(1)
    const limit = Math.min(parseInt(rest.find(a => /^\d+$/.test(a)) || "50", 10), 200)

    try {
      const entries = await logger.queryLogs({ level, coordinator, limit })
      if (entries.length === 0) {
        return { handled: true, output: "\n  No hay entradas de log.\n" }
      }
      const lines = entries.map(e => {
        const color = e.level === "error" ? "\u2717" : e.level === "warn" ? "\u26a0" : e.level === "debug" ? "\u25cb" : "\u2713"
        const ts = e.timestamp.slice(11, 19) // HH:MM:SS
        const msg = e.message.slice(0, 120)
        return `  ${color} [${ts}] ${e.level.toUpperCase().padEnd(5)} ${msg}`
      })
      return {
        handled: true,
        output: `\n  \u00daltimos ${entries.length} logs:\n\n${lines.join("\n")}\n`,
      }
    } catch (err) {
      return { handled: true, output: `  \u2717 Error leyendo logs: ${(err as Error).message}` }
    }
  }

  if (action === "follow" || action === "tail") {
    return {
      handled: true,
      output: "  Modo follow: usa el panel de logs con Ctrl+L en la TUI",
    }
  }

  return {
    handled: true,
    output: "opciones: list [debug|info|warn|error] [@coordinator] [limit]\nEjemplo: /logs list info @backend 20",
  }
}

async function handleTelegramCommand(
  args: string[],
  db: ReturnType<typeof getDb>,
  ui?: UiCallbacks,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action || action === "status") {
    const row = db.query("SELECT * FROM channels WHERE id = 'telegram'").get() as any
    if (!row) {
      return {
        handled: true,
        output: [
          "",
          "  Telegram no configurado.",
          "",
          "  Ejecuta en terminal:",
          "    hivecode telegram connect",
          "",
        ].join("\n"),
      }
    }
    let config: Record<string, any> = {}
    try { config = JSON.parse(Buffer.from(row.config_encrypted as string, "base64").toString()) } catch {}
    return {
      handled: true,
      output: [
        "",
        `  Estado:      ${row.status ?? "desconocido"}`,
        `  Activo:      ${row.enabled ? "sí" : "no"}`,
        `  DM Policy:   ${config.dmPolicy ?? "—"}`,
        `  Grupos:      ${config.groups ? "sí" : "no"}`,
        config.allowFrom?.length ? `  Lista blanca: ${(config.allowFrom as string[]).join(", ")}` : "",
        "",
      ].filter(Boolean).join("\n"),
    }
  }

  if (action === "disconnect") {
    db.query("UPDATE channels SET enabled = 0, status = 'disconnected' WHERE id = 'telegram'").run()
    return { handled: true, output: "  ✓ Telegram desconectado" }
  }

  if (action === "connect" || action === "edit") {
    // Inline modal if available
    if (ui?.showConfigModal) {
      const existing = db.query("SELECT config_encrypted FROM channels WHERE id = 'telegram'").get() as any
      let existingConfig: Record<string, any> = {}
      if (existing?.config_encrypted) {
        try { existingConfig = JSON.parse(Buffer.from(existing.config_encrypted, "base64").toString()) } catch {}
      }
      const values = await ui.showConfigModal(`telegram_${action}`, `Telegram \u2014 ${action === "connect" ? "Conectar" : "Editar"}`, [
        { key: "bot_token", label: "Bot Token",    placeholder: "123456:ABC-DEF\u2026", required: true,  secret: true,  field_type: "text" },
        { key: "dm_policy", label: "DM Policy",    placeholder: "",                required: false, secret: false, field_type: "select", options: ["allowAll", "allowList", "denyAll"] },
        { key: "groups",    label: "Grupos",        placeholder: "",                required: false, secret: false, field_type: "select", options: ["no", "s\u00ed"] },
        { key: "allow_from",label: "Lista blanca",  placeholder: "@usuario1,@usuario2", required: false, secret: false, field_type: "text" },
      ])
      if (!values) return { handled: true, output: "  Configuraci\u00f3n cancelada" }
      const configJson = JSON.stringify({
        botToken: values.bot_token,
        dmPolicy: values.dm_policy || "allowAll",
        groups: values.groups === "s\u00ed",
        allowFrom: values.allow_from ? values.allow_from.split(",").map((s: string) => s.trim()).filter(Boolean) : [],
        enabled: true,
      })
      db.query(`
        INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status)
        VALUES ('telegram', 'telegram', ?, 1, 'connected')
      `).run(Buffer.from(configJson).toString("base64"))
      return {
        handled: true,
        output: `  \u2713 Telegram ${action === "connect" ? "conectado" : "actualizado"}`,
      }
    }
    // Fallback wizard
    if (ui?.suspendTui && ui?.resumeTui && ui?.runTelegramConnectWizard) {
      await ui.suspendTui()
      try {
        const result = await ui.runTelegramConnectWizard()
        if (result) {
          const configJson = JSON.stringify({
            dmPolicy: result.dmPolicy,
            allowFrom: result.allowFrom,
            groups: result.groups,
            enabled: true,
          })
          db.query(`
            INSERT OR REPLACE INTO channels (id, type, config_encrypted, enabled, status)
            VALUES ('telegram', 'telegram', ?, 1, 'connected')
          `).run(Buffer.from(configJson).toString("base64"))
          return {
            handled: true,
            output: `  \u2713 Telegram ${action === "connect" ? "conectado" : "actualizado"}`,
          }
        }
        return { handled: true, output: "  Configuraci\u00f3n cancelada" }
      } finally {
        ui.resumeTui()
      }
    }
    return {
      handled: true,
      output: [
        "",
        `  /telegram ${action} requiere wizard interactivo.`,
        "",
        "  Ejecuta en terminal:",
        `    hivecode telegram ${action}`,
        "",
      ].join("\n"),
    }
  }

  return {
    handled: true,
    output: "opciones: status | connect | disconnect | edit\n\nEscribe /help /telegram",
  }
}

export async function parseInternalCommand(
  input: string,
  db: ReturnType<typeof getDb>,
  ctx?: ContextState,
  ui?: UiCallbacks,
): Promise<CommandResult> {
  if (!input.startsWith("/")) {
    return { handled: false }
  }

  const ctxState = ctx ?? getCtx(db)
  const parts = input.slice(1).split(/\s+/)
  const cmd = parts[0]?.toLowerCase()
  const args = parts.slice(1)

  switch (cmd) {
    case "provider":
      return handleProviderCommand(args, db, ctxState, ui)
    case "modelo":
      return handleModelCommand(args, db, ctxState, ui)
    case "mcp":
      return handleMcpCommand(args, db, ctxState, ui)
    case "skill":
      return handleSkillCommand(args, db)
    case "mode":
      return handleModeCommand(args, db, ctxState)
    case "task":
      return handleTaskCommand(args, db)
    case "narrative":
      return handleNarrativeCommand(args, db)
    case "ace":
      return handleAceCommand(args, db)
    case "github":
      return handleGithubCommand(args, db, ui)
    case "telegram":
      return handleTelegramCommand(args, db, ui)
    case "run": {
      const task = args.join(" ")
      if (task && ui?.executeTask) {
        const output = await ui.executeTask(task, ctxState.activeMode)
        return { handled: true, output }
      }
      if (ui?.showConfigModal) {
        const result = await ui.showConfigModal("run_task", "Ejecutar tarea", [
          { key: "task", label: "Descripción de la tarea", placeholder: "Describe lo que quieres hacer...", required: true, secret: false, field_type: "text" },
        ])
        if (result?.task && ui.executeTask) {
          const output = await ui.executeTask(result.task, ctxState.activeMode)
          return { handled: true, output }
        }
        return { handled: true, output: result?.task ? "  Tarea ejecutada" : "  Cancelado" }
      }
      return { handled: true, output: "  Uso: /run <tarea> o escribe la tarea directamente" }
    }
    case "plan": {
      const task = args.join(" ")
      if (task && ui?.executeTask) {
        const output = await ui.executeTask(task, "plan")
        return { handled: true, output }
      }
      if (ui?.showConfigModal) {
        const result = await ui.showConfigModal("plan_task", "Planificar tarea", [
          { key: "task", label: "Descripción de la tarea", placeholder: "Describe lo que quieres planificar...", required: true, secret: false, field_type: "text" },
        ])
        if (result?.task && ui.executeTask) {
          const output = await ui.executeTask(result.task, "plan")
          return { handled: true, output }
        }
        return { handled: true, output: result?.task ? "  Plan generado" : "  Cancelado" }
      }
      return { handled: true, output: "  Uso: /plan <tarea> o escribe la tarea directamente" }
    }
    case "doctor": {
      const output = runDoctor(db)
      if (ui?.showInfoModal) {
        await ui.showInfoModal("Diagnóstico del sistema", output)
        return { handled: true, output: "" }
      }
      return { handled: true, output }
    }
    case "help":
      return { handled: true, output: renderHelp(args[0]) }
    case "version":
      return { handled: true, output: `hivecode v${VERSION}  ${GIT_HASH}` }
    case "logs":
      return handleLogsCommand(args)
    case "session":
      return handleSessionCommand(args, db, ctxState)
    case "compact":
      return handleCompactCommand(db, ctxState)
    case "note":
      return handleNoteCommand(args, db, ctxState)
    case "env": {
      const safe = ["HOME", "USER", "SHELL", "TERM", "PATH", "BUN_VERSION", "NODE_ENV"]
      const lines = safe.map(k => `  ${k}=${process.env[k] || ""}`)
      return { handled: true, output: "\n" + lines.join("\n") + "\n" }
    }
    default: {
      const suggestion = renderSuggestions(input)
      const hint = suggestion.length > 0
        ? `\n\n  \u00bfQuisiste decir?\n  ${suggestion.slice(0, 3).map(s => `  ${s}`).join("\n")}`
        : ""
      return {
        handled: true,
        output: `  comando desconocido: ${cmd}${hint}\n\n  Escribe /help para ver la lista completa`,
      }
    }
  }
}

export { renderHelp, renderSuggestions, getCtx }
export type { CommandResult as InternalCommandResult }
