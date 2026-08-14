import { logger } from "@johpaz/hivecode-core/utils/logger"
import { runReflector } from "../agent/reflector"
import { callLLM, resolveProviderConfig } from "@johpaz/hivecode-core/agent/llm-client"
import { saveScratchpadNote, getScratchpad, deleteScratchpadNote } from "@johpaz/hivecode-core/agent/conversation-store"
import { hasProviderApiKey, storeProviderApiKey, encryptConfig, isFreeProvider } from "@johpaz/hivecode-core/storage/crypto"
import { col, nextId } from "@johpaz/hivecode-core/storage/hive"
import type {
  CodeConfigDoc,
  CodeFileSnapshotDoc,
  CodeNarrativeDoc,
  CodePlaybookDoc,
  CodeReflectionDoc,
  CodeSessionDoc,
  CodeSessionModeDoc,
  CodeTaskDoc,
  CodeTraceDoc,
  CodeTurnDoc,
  McpServerDoc,
  ModelDoc,
  ProviderDoc,
  SkillDoc,
  SummaryDoc,
} from "@johpaz/hivecode-core/storage/collections"

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
  /** Start or restart a channel in the running gateway (called after saving channel config to DB) */
  startChannel?: (type: string, accountId: string, config: Record<string, unknown>) => Promise<void>
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
  enabled: boolean
}

const VERSION = "1.0.0"
const GIT_HASH = process.env.GIT_HASH || "dev"

type DbCompat = unknown

function nowIso(): string {
  return new Date().toISOString()
}

async function scanDocs<T>(collection: string): Promise<T[]> {
  return (await (await col<T>(collection)).scan()).map((entry) => entry.doc)
}

async function getDoc<T>(collection: string, id: string): Promise<T | null> {
  return (await (await col<T>(collection)).get(id))?.doc ?? null
}

async function getVersionedDoc<T>(collection: string, id: string) {
  return (await col<T>(collection)).get(id)
}

async function getCodeConfig(key: string): Promise<string> {
  return (await getDoc<CodeConfigDoc>("codeConfig", key))?.value ?? ""
}

async function setCodeConfig(key: string, value: string | null): Promise<void> {
  const codeConfig = await col<CodeConfigDoc>("codeConfig")
  const existing = await codeConfig.get(key)
  await codeConfig.put(key, { key, value, updated_at: Date.now() }, { expectedVersion: existing?.version ?? 0 })
}

async function deleteCodeConfig(key: string): Promise<void> {
  await (await col<CodeConfigDoc>("codeConfig")).delete(key)
}

async function listProviderDocs(): Promise<ProviderDoc[]> {
  return (await scanDocs<ProviderDoc>("providers")).sort((a, b) => a.id.localeCompare(b.id))
}

async function upsertProviderDoc(providerId: string, patch: Partial<ProviderDoc>): Promise<void> {
  const providers = await col<ProviderDoc>("providers")
  const existing = await providers.get(providerId)
  const now = Date.now()
  const doc: ProviderDoc = {
    id: providerId,
    name: patch.name ?? existing?.doc.name ?? providerId,
    base_url: patch.base_url ?? existing?.doc.base_url ?? null,
    category: patch.category ?? existing?.doc.category ?? "llm",
    num_ctx: patch.num_ctx ?? existing?.doc.num_ctx ?? null,
    num_gpu: patch.num_gpu ?? existing?.doc.num_gpu ?? -1,
    enabled: patch.enabled ?? existing?.doc.enabled ?? true,
    active: patch.active ?? existing?.doc.active ?? false,
    is_free_tier: patch.is_free_tier ?? existing?.doc.is_free_tier ?? false,
    created_at: existing?.doc.created_at ?? patch.created_at ?? now,
  }
  await providers.put(providerId, doc, { expectedVersion: existing?.version ?? 0 })
}

async function updateProviderDoc(providerId: string, patch: Partial<ProviderDoc>): Promise<void> {
  const providers = await col<ProviderDoc>("providers")
  const existing = await providers.get(providerId)
  if (!existing) return
  await providers.put(providerId, { ...existing.doc, ...patch }, { expectedVersion: existing.version })
}

async function upsertModelDoc(modelId: string, patch: Partial<ModelDoc> & { provider_id: string }): Promise<void> {
  const models = await col<ModelDoc>("models")
  const existing = await models.get(modelId)
  const doc: ModelDoc = {
    id: modelId,
    provider_id: patch.provider_id,
    name: patch.name ?? existing?.doc.name ?? modelId,
    model_type: patch.model_type ?? existing?.doc.model_type ?? "llm",
    context_window: patch.context_window ?? existing?.doc.context_window ?? 20000,
    capabilities: patch.capabilities ?? existing?.doc.capabilities ?? null,
    enabled: patch.enabled ?? existing?.doc.enabled ?? true,
    active: patch.active ?? existing?.doc.active ?? false,
  }
  await models.put(modelId, doc, { expectedVersion: existing?.version ?? 0 })
}

async function findModelsByProvider(providerId: string): Promise<ModelDoc[]> {
  return (await (await col<ModelDoc>("models")).findBy("provider_id", providerId))
    .map((entry) => entry.doc)
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function upsertMcpServerDoc(id: string, patch: Partial<McpServerDoc> & { name: string; transport: string }): Promise<void> {
  const servers = await col<McpServerDoc>("mcpServers")
  const existing = await servers.get(id)
  const doc: McpServerDoc = {
    id,
    name: patch.name,
    transport: patch.transport,
    command: patch.command ?? existing?.doc.command ?? null,
    args: patch.args ?? existing?.doc.args ?? null,
    env_encrypted: patch.env_encrypted ?? existing?.doc.env_encrypted ?? null,
    env_iv: patch.env_iv ?? existing?.doc.env_iv ?? null,
    headers_encrypted: patch.headers_encrypted ?? existing?.doc.headers_encrypted ?? null,
    headers_iv: patch.headers_iv ?? existing?.doc.headers_iv ?? null,
    url: patch.url ?? existing?.doc.url ?? null,
    enabled: patch.enabled ?? existing?.doc.enabled ?? true,
    active: patch.active ?? existing?.doc.active ?? false,
    builtin: patch.builtin ?? existing?.doc.builtin ?? false,
    status: patch.status ?? existing?.doc.status ?? "disconnected",
    tools_count: patch.tools_count ?? existing?.doc.tools_count ?? 0,
    user_id: patch.user_id ?? existing?.doc.user_id,
  }
  await servers.put(id, doc, { expectedVersion: existing?.version ?? 0 })
}

async function getActiveSession(): Promise<CodeSessionDoc | null> {
  const sessions = await scanDocs<CodeSessionDoc>("codeSessions")
  return sessions
    .sort((a, b) => (b.last_active || b.created_at || b.id).localeCompare(a.last_active || a.created_at || a.id))[0] ?? null
}

async function getSessionTurns(sessionId: string): Promise<CodeTurnDoc[]> {
  return (await (await col<CodeTurnDoc>("codeTurns")).findBy("session_id", sessionId))
    .map((entry) => entry.doc)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

async function listRecentSessionsWithTurns(limit = 15): Promise<Array<CodeSessionDoc & { turns: number }>> {
  const sessions = (await scanDocs<CodeSessionDoc>("codeSessions"))
    .sort((a, b) => b.last_active.localeCompare(a.last_active))
    .slice(0, limit)
  const counts = await Promise.all(sessions.map(async (session) => ({
    id: session.id,
    turns: (await getSessionTurns(session.id)).length,
  })))
  const countMap = new Map(counts.map((entry) => [entry.id, entry.turns]))
  return sessions.map((session) => ({ ...session, turns: countMap.get(session.id) ?? 0 }))
}

async function getCtx(): Promise<ContextState> {
  const session = await getActiveSession()
  const sessionId = session?.id ?? "none"
  const provider = await getCodeConfig("default_provider")
  const model = provider ? await getCodeConfig(`provider_model_${provider}`) : ""
  const rawMode = await getCodeConfig("default_mode")
  const mode = rawMode === "plan" || rawMode === "approval" || rawMode === "auto" ? rawMode : "approval"
  const projectPath = session?.project_path ?? process.cwd()

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
  { command: "/narrative search", category: "narrative", description: "buscar en narrativo con HiveDB" },
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
  { command: "/session list", category: "session", description: "listar sesiones recientes" },
  { command: "/session resume", category: "session", description: "reanudar sesion por id" },
  { command: "/session new", category: "session", description: "iniciar nueva sesion" },
  { command: "/session status", category: "session", description: "ver sesion activa" },
  { command: "/telegram status", category: "telegram", description: "estado de telegram" },
  { command: "/telegram connect", category: "telegram", description: "conectar telegram" },
  { command: "/telegram disconnect", category: "telegram", description: "desconectar telegram" },
  { command: "/telegram edit", category: "telegram", description: "editar configuracion telegram" },
  { command: "/version", category: "system", description: "version de hivecode" },
]

export function syncCommandsToIndex(_db?: DbCompat): void {
  // Kept as a compatibility export for older callers. Command suggestions now
  // use the in-memory command catalog below.
}

function renderSuggestions(input: string): string[] {
  const prefix = input.startsWith("/") ? input.slice(1) : input
  if (!prefix || prefix.length < 1) {
    console.error(`[suggestions] empty prefix, returning first 20 commands`)
    return ALL_COMMANDS.slice(0, 20).map(c => c.command)
  }
  const normalized = prefix.toLowerCase()
  const match = ALL_COMMANDS.filter(c =>
    c.command.toLowerCase().startsWith(`/${normalized}`) ||
    c.description.toLowerCase().includes(normalized) ||
    c.category.toLowerCase().includes(normalized)
  )
  console.error(`[suggestions] prefix fallback for "${prefix}": ${match.length} results`)
  return match.slice(0, 20).map(c => c.command)
}

async function handleFreeCommand(
  args: string[],
  _db: DbCompat,
  ctxState: ContextState,
  ui?: UiCallbacks
): Promise<CommandResult> {
  const sub = args[0]?.toLowerCase()
  const FREE = "hivecode-free"

  // /free set  — activate as default provider
  if (sub === "set" || sub === "set-default" || sub === "default") {
    const provider = await getDoc<ProviderDoc>("providers", FREE)
    if (!provider) {
      return { handled: true, output: `  ✗ provider '${FREE}' no existe. Ejecuta el setup inicial.` }
    }
    await setCodeConfig("default_provider", FREE)
    return {
      handled: true,
      output: `  ✓ ${FREE} es ahora el provider por defecto`,
      newState: { activeProvider: FREE, activeModel: ctxState.activeModel },
    }
  }

  // /free cap  — DEPRECATED: cap is now server-side. Point user to backend.
  if (sub === "cap") {
    return {
      handled: true,
      output:
        "  El cap diario lo aplica tu API backend, no el cliente.\n" +
        "  Si ves 'Free tier agotado', el servidor rechazó la request.\n" +
        "  Configura el cap en tu backend (default recomendado: 50K tokens/día).",
    }
  }

  // /free (default)  — show available models + status
  let authStatus = "✗ sin autenticación (corre /auth login)"
  try {
    const { hasStoredAuth } = await import("@johpaz/hivecode-core/auth/auth-cli")
    const status = await hasStoredAuth()
    if (status.hasToken && !status.expired) {
      const exp = status.expiresAt ? new Date(status.expiresAt * 1000).toISOString() : "—"
      authStatus = `✓ autenticado como ${status.email || "—"}  ·  expira ${exp}`
    } else if (status.expired) {
      authStatus = `⚠ token expirado (corre /auth login)`
    }
  } catch { /* ignore */ }

  const models = (await findModelsByProvider(FREE)).filter((model) => model.model_type === "llm" && model.enabled)

  const lines: string[] = [
    "  hivecode-free — modelos vía tu API (Firebase Auth)",
    "",
    `  Estado: ${isFreeProvider(FREE) ? "free tier" : "configurado"}`,
    `  Auth:   ${authStatus}`,
    "",
    `  ${models.length} modelos disponibles:`,
    ...models.map((m) => {
      const caps = (() => { try { return (JSON.parse(m.capabilities ?? "[]") as string[]).join(", ") } catch { return "" } })()
      return `    · ${m.id.padEnd(50)} ctx=${m.context_window.toString().padStart(8)}  ${caps}`
    }),
    "",
    "  Comandos:",
    "    /auth login       abrir navegador y autenticarse (Firebase)",
    "    /free             mostrar este panel",
    "    /free set         activar como provider por defecto",
    "    /modelo set hivecode-free <modelo>",
    "",
    "  El cap diario lo aplica tu API backend (default 50K tokens/día).",
  ]
  return { handled: true, output: "\n" + lines.join("\n") + "\n" }
}

async function handleAuthCommand(
  args: string[],
  _db: DbCompat,
  ctxState: ContextState,
  ui?: UiCallbacks
): Promise<CommandResult> {
  const sub = (args[0] || "login").toLowerCase()
  try {
    const { runAuthCli, hasStoredAuth, clearAuth } = await import(
      "@johpaz/hivecode-core/auth/auth-cli"
    )

    if (sub === "logout" || sub === "off") {
      await clearAuth()
      return { handled: true, output: "  ✓ Sesión hivecode-free cerrada" }
    }

    if (sub === "status" || sub === "whoami") {
      const status = await hasStoredAuth()
      if (!status.hasToken) {
        return { handled: true, output: "  ✗ No autenticado.  /auth login" }
      }
      if (status.expired) {
        return { handled: true, output: `  ⚠ Token expirado${status.email ? ` (${status.email})` : ""}.  /auth login` }
      }
      const exp = status.expiresAt ? new Date(status.expiresAt * 1000).toISOString() : "—"
      return { handled: true, output: `  ✓ Autenticado como ${status.email || "—"}  ·  expira ${exp}` }
    }

    // /auth login  (default)  — open browser, capture token
    const apiBase =
      process.env.HIVE_FREE_API_URL || "https://api.hivecode.local/v1"
    const result = await runAuthCli({ apiBase })
    if (!result) {
      return { handled: true, output: "  ✗ Auth cancelada o fallida. Intenta de nuevo." }
    }
    const exp = result.expiresAt
      ? new Date(result.expiresAt * 1000).toISOString()
      : "—"
    return {
      handled: true,
      output:
        `  ✓ Token guardado\n` +
        `    email:  ${result.email || "—"}\n` +
        `    expira: ${exp}\n\n` +
        `  Ahora puedes usar /free set y los modelos hivecode-free.`,
    }
  } catch (err) {
    return { handled: true, output: `  ✗ Error: ${(err as Error).message}` }
  }
}

async function runDoctor(_db: DbCompat): Promise<string> {
  const checks: string[] = []
  try {
    const bunVer = process.versions.bun ?? "unknown"
    checks.push(`  \u2713 Bun ${bunVer}`)
  } catch { checks.push("  \u2717 Bun version check failed") }

  try {
    const providers = (await (await col<ProviderDoc>("providers")).scan())
      .map((entry) => entry.doc)
      .filter((provider) => provider.enabled)
    checks.push(`  \u2713 Providers: ${providers.length} enabled`)
  } catch { checks.push("  \u2717 Provider check failed") }

  try {
    await col("meta")
    checks.push("  \u2713 HiveDB disponible")
  } catch { checks.push("  \u2717 HiveDB check failed") }

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
          lines.push("  <query>    texto a buscar en HiveDB")
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
  _db: DbCompat,
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
      const providers = (await listProviderDocs())
        .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          base_url: provider.base_url,
          enabled: provider.enabled,
        }))
      const modelMap = new Map(
        (await scanDocs<CodeConfigDoc>("codeConfig"))
          .filter((doc) => doc.key.startsWith("provider_model_") && doc.value)
          .map((doc) => [doc.key.replace("provider_model_", ""), doc.value ?? ""])
      )
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
        await upsertProviderDoc(providerId, {
          name: values.name || providerId,
          base_url: values.base_url || null,
          enabled: true,
          category: (values.category || "llm") as ProviderDoc["category"],
        })
        await setCodeConfig("default_provider", providerId)
        return {
          handled: true,
          output: `  \u2713 Provider ${providerId} configurado`,
          newState: { activeProvider: providerId },
        }
      }
      // Fallback: wizard if available, else non-interactive
      if (ui?.suspendTui && ui?.resumeTui && ui?.runProviderSetupWizard) {
        const known = (await listProviderDocs()).map(r => r.id)
        await ui.suspendTui()
        try {
          const result = await ui.runProviderSetupWizard(known, VERSION)
          if (result) {
            await storeProviderApiKey(result.provider, result.apiKey)
            await upsertProviderDoc(result.provider, {
              name: result.provider,
              base_url: result.baseUrl || null,
              enabled: true,
            })
            await setCodeConfig("default_provider", result.provider)
            if (result.model) {
              await setCodeConfig(`provider_model_${result.provider}`, result.model)
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
      const existing = await getDoc<ProviderDoc>("providers", name)
      if (existing) {
        return { handled: true, output: `  ${name} ya existe. Usa /provider set ${name} para activarlo.` }
      }
      await upsertProviderDoc(name, { name, enabled: true })
      return {
        handled: true,
        output: `  \u2713 ${name} agregado\n\n  Configurar API key con: hivecode secret set provider.${name}\n  Activar con: /provider set ${name}`,
      }
    }
    case "set": {
      if (ui?.showConfigModal) {
        // Muestra TODOS los providers LLM \u2014 con y sin API key
        const allProviders = (await listProviderDocs())
          .filter((provider) => provider.category === "llm")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((provider) => ({ id: provider.id, name: provider.name }))

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
        await updateProviderDoc(selectedId, { enabled: true })
        await setCodeConfig("default_provider", selectedId)

        // Cambiar al primer modelo del nuevo provider para evitar 401 por modelo incompatible
        const firstModel = (await findModelsByProvider(selectedId))
          .filter((model) => model.enabled)
          .sort((a, b) => a.id.localeCompare(b.id))[0]
        const newModel = firstModel?.id ?? null
        if (newModel) {
          await setCodeConfig(`provider_model_${selectedId}`, newModel)
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
        const providers = await listProviderDocs()
        return {
          handled: true,
          output: "uso: /provider set <nombre>\ndisponibles: " + providers.map(p => p.id).join(", "),
        }
      }
      const row = await getDoc<ProviderDoc>("providers", name)
      if (!row) return { handled: true, output: `  Provider no encontrado: ${name}\n  Agrega con: /provider add ${name}` }
      await setCodeConfig("default_provider", name)
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
        const row = await getDoc<ProviderDoc>("providers", name)
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
      const providers = (await listProviderDocs()).map((provider) => ({
        id: provider.id,
        name: provider.name,
        base_url: provider.base_url,
        enabled: provider.enabled,
      }))
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

async function handleModelCommand(
  args: string[],
  _db: DbCompat,
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
        ? (await findModelsByProvider(providerId)).filter((model) => model.enabled)
        : (await scanDocs<ModelDoc>("models"))
            .filter((model) => model.enabled)
            .sort((a, b) => a.provider_id.localeCompare(b.provider_id) || a.name.localeCompare(b.name))

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
        const enabledProviders = (await listProviderDocs())
          .filter((provider) => provider.enabled)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((provider) => ({ id: provider.id }))
        const providers = (await Promise.all(enabledProviders.map(async p => ({
          ...p,
          hasApiKey: await hasProviderApiKey(p.id),
        })))).filter(p => p.hasApiKey)
        if (providers.length === 0) {
          return { handled: true, output: "  No hay providers con API key configurada. Agrega uno con: /provider add" }
        }
        // Build combined options: "provider :: modelId" — solo providers con API key
        const providerIds = new Set(providers.map(p => p.id))
        const dbModels = (await scanDocs<ModelDoc>("models"))
          .filter((model) => model.enabled && providerIds.has(model.provider_id))
          .sort((a, b) => a.provider_id.localeCompare(b.provider_id) || a.id.localeCompare(b.id))

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
        await setCodeConfig(`provider_model_${providerId}`, modelId)
        await setCodeConfig("default_provider", providerId)
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
        const rows = (await findModelsByProvider(provider)).filter((entry) => entry.enabled).sort((a, b) => a.id.localeCompare(b.id))
        const hint = rows.length > 0 ? rows.map(r => r.id).join(", ") : "(ninguno en BD)"
        return {
          handled: true,
          output: `uso: /modelo set <provider> <modelo>\nDisponibles para ${provider}: ${hint}`,
        }
      }
      await setCodeConfig(`provider_model_${provider}`, model)
      return {
        handled: true,
        output: `  \u2b22 Modelo: ${model} [${provider}]`,
        newState: { activeModel: model },
      }
    }

    case "add": {
      if (ui?.showConfigModal) {
        const providers = (await listProviderDocs())
          .filter((provider) => provider.enabled)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((provider) => ({ id: provider.id }))
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
        await upsertModelDoc(modelId, {
          provider_id: providerId,
          name: modelName,
          model_type: modelType as ModelDoc["model_type"],
          context_window: ctxWindow,
          enabled: true,
        })
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
      await upsertModelDoc(modelId, { provider_id: providerId, name: modelId, model_type: "llm" })
      return { handled: true, output: `  \u2713 Modelo ${modelId} agregado a ${providerId}` }
    }

    case "delete":
    case "remove": {
      if (ui?.showConfigModal) {
        const rows = (await scanDocs<ModelDoc>("models"))
          .filter((model) => model.enabled)
          .sort((a, b) => a.provider_id.localeCompare(b.provider_id) || a.id.localeCompare(b.id))
        if (rows.length === 0) return { handled: true, output: "  No hay modelos en la BD." }
        const options = rows.map(m => `${m.provider_id} :: ${m.id}`)
        const values = await ui.showConfigModal("model_delete", "Eliminar Modelo", [
          { key: "combo", label: "Modelo a eliminar", placeholder: "", required: true, secret: false, field_type: "select", options },
        ])
        if (!values) return { handled: true, output: "  Cancelado" }
        const parts = values.combo.split(" :: ")
        const modelId = parts[1]?.trim()
        if (!modelId) return { handled: true, output: "  Selecci\u00f3n inv\u00e1lida" }
        await (await col<ModelDoc>("models")).delete(modelId)
        return { handled: true, output: `  \u2713 Modelo ${modelId} eliminado` }
      }
      const modelId = rest[0]
      if (!modelId) return { handled: true, output: "uso: /modelo delete <id>" }
      await (await col<ModelDoc>("models")).delete(modelId)
      return { handled: true, output: `  \u2713 Modelo ${modelId} eliminado` }
    }

    case "info": {
      const modelId = rest[0] || ctx.activeModel
      const row = modelId
        ? await getDoc<ModelDoc>("models", modelId)
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
  _db: DbCompat,
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
      const rows = (await scanDocs<McpServerDoc>("mcpServers")).sort((a, b) => a.id.localeCompare(b.id))
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
          { key: "headers", label: "Headers JSON (opcional)", placeholder: '{"Authorization":"Bearer token"}', required: false, secret: true, field_type: "text" },
        ])
        if (!values) return { handled: true, output: "  Configuraci\u00f3n cancelada" }
        const id = values.id.trim().toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "_")
        const transport = values.transport || "sse"
        const url = values.url || null
        const command = values.command || null
        let headersEncrypted: string | null = null
        let headersIv: string | null = null
        if (values.headers && values.headers.trim()) {
          try {
            const headersObj = JSON.parse(values.headers.trim())
            const enc = encryptConfig(headersObj)
            headersEncrypted = enc.encrypted
            headersIv = enc.iv
          } catch {
            return { handled: true, output: "  Headers inv\u00e1lidos: debe ser JSON v\u00e1lido" }
          }
        }
        await upsertMcpServerDoc(id, {
          name: values.name || id,
          transport,
          url,
          command,
          headers_encrypted: headersEncrypted,
          headers_iv: headersIv,
          enabled: true,
          active: false,
          builtin: false,
          status: "disconnected",
        })
        return { handled: true, output: `  \u2713 MCP ${id} a\u00f1adido (${transport})\n  El hot-reload lo conectar\u00e1 autom\u00e1ticamente.` }
      }
      const input = rest[0]
      if (!input) return { handled: true, output: "uso: /mcp add <url-o-nombre>\nejemplo: /mcp add http://localhost:3000/sse" }
      const id = input.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()
      const isUrl = input.startsWith("http://") || input.startsWith("https://")
      const transport = isUrl ? "sse" : "stdio"
      await upsertMcpServerDoc(id, {
        name: input,
        transport,
        url: isUrl ? input : null,
        command: isUrl ? null : input,
        enabled: true,
        active: false,
        builtin: false,
        status: "disconnected",
      })
      return { handled: true, output: `  \u2713 MCP ${id} a\u00f1adido (${transport})\n  El hot-reload lo conectar\u00e1 autom\u00e1ticamente.` }
    }
    case "enable": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /mcp enable <nombre>" }
      const row = await getVersionedDoc<McpServerDoc>("mcpServers", name)
      if (row) await (await col<McpServerDoc>("mcpServers")).put(name, { ...row.doc, enabled: true }, { expectedVersion: row.version })
      return { handled: true, output: `  \u2713 MCP ${name} habilitado` }
    }
    case "disable": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /mcp disable <nombre>" }
      const row = await getVersionedDoc<McpServerDoc>("mcpServers", name)
      if (row) await (await col<McpServerDoc>("mcpServers")).put(name, { ...row.doc, enabled: false }, { expectedVersion: row.version })
      return { handled: true, output: `  \u2713 MCP ${name} deshabilitado` }
    }
    case "remove": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /mcp remove <nombre>" }
      const row = await getDoc<McpServerDoc>("mcpServers", name)
      if (!row) return { handled: true, output: `  MCP no encontrado: ${name}` }
      await (await col<McpServerDoc>("mcpServers")).delete(name)
      return { handled: true, output: `  \u2713 MCP ${name} eliminado` }
    }
    case "inspect": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /mcp inspect <nombre>" }
      const row = await getDoc<McpServerDoc>("mcpServers", name)
      if (!row) return { handled: true, output: `  MCP no encontrado: ${name}` }
      const lines = [
        ``,
        `  \u26a1 ${row.name} (${row.id})`,
        `  Transporte: ${row.transport}`,
        row.url     ? `  URL: ${row.url}` : null,
        row.command ? `  Comando: ${row.command}` : null,
        row.args    ? `  Args: ${row.args}` : null,
        `  Estado: ${row.status || "unknown"}`,
        `  Habilitado: ${row.enabled ? "s\u00ed" : "no"}`,
        row.tools_count ? `  Tools: ${row.tools_count}` : null,
      ].filter(Boolean)
      return { handled: true, output: lines.join("\n") }
    }
    case "test": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /mcp test <nombre>" }
      const row = await getDoc<McpServerDoc>("mcpServers", name)
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
          await upsertMcpServerDoc(id, {
            name,
            transport,
            url,
            command,
            args,
            enabled: true,
            active: false,
            builtin: false,
            status: "disconnected",
          })
          added++
        }
        return { handled: true, output: `  \u2713 ${added} servidores MCP cargados desde ${filePath}` }
      } catch (err) {
        return { handled: true, output: `  \u2717 Error cargando MCP config: ${(err as Error).message}` }
      }
    }
    default:
      return { handled: true, output: "opciones: list | add | remove | inspect | enable | disable | test\n\nEscribe /help /mcp" }
  }
}

async function handleSkillCommand(
  args: string[],
  _db: DbCompat,
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
      const rows = (await scanDocs<SkillDoc>("skills")).sort((a, b) => a.id.localeCompare(b.id))
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
      const row = await getVersionedDoc<SkillDoc>("skills", name)
      if (row) await (await col<SkillDoc>("skills")).put(name, { ...row.doc, active: true, updated_at: Date.now() }, { expectedVersion: row.version })
      return { handled: true, output: `  \u2713 Skill ${name} habilitada` }
    }
    case "disable": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /skill disable <nombre>" }
      const row = await getVersionedDoc<SkillDoc>("skills", name)
      if (row) await (await col<SkillDoc>("skills")).put(name, { ...row.doc, active: false, updated_at: Date.now() }, { expectedVersion: row.version })
      return { handled: true, output: `  \u2713 Skill ${name} deshabilitada` }
    }
    case "info": {
      const name = rest[0]
      if (!name) return { handled: true, output: "uso: /skill info <nombre>" }
      const row = await getDoc<SkillDoc>("skills", name)
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
        const skills = await col<SkillDoc>("skills")
        const existing = await skills.get(id)
        const now = Date.now()
        await skills.put(id, {
          id,
          name: skillName,
          description: `Imported from ${path}`,
          version: existing?.doc.version ?? "0.0.1",
          author: existing?.doc.author ?? "local",
          icon: existing?.doc.icon ?? "skill",
          category: "custom",
          permissions: existing?.doc.permissions ?? JSON.stringify([]),
          dependencies: existing?.doc.dependencies ?? JSON.stringify([]),
          tools: existing?.doc.tools ?? "",
          triggers: existing?.doc.triggers ?? "",
          preferred_agents: existing?.doc.preferred_agents ?? JSON.stringify([]),
          body: content,
          version_num: existing?.doc.version_num ?? 1,
          active: true,
          created_at: existing?.doc.created_at ?? now,
          updated_at: now,
        }, { expectedVersion: existing?.version ?? 0 })
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
  _db: DbCompat,
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
      await setCodeConfig("default_mode", mode)
      return {
        handled: true,
        output: `  \u2b22 Modo cambiado a: ${mode.toUpperCase()}`,
        newState: { activeMode: mode as "plan" | "approval" | "auto" },
      }
    }
    case "history": {
      const rows = (await scanDocs<CodeSessionModeDoc>("codeSessionModes"))
        .sort((a, b) => b.changed_at.localeCompare(a.changed_at))
        .slice(0, 10)
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
  _db: DbCompat,
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
      const rows = (await scanDocs<CodeTaskDoc>("codeTasks"))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
      if (rows.length === 0) return { handled: true, output: "\n  No hay tareas.\n" }
      const lines = rows.map(r => `  \u25b8 ${r.id.slice(0, 8).padEnd(10)} ${r.status.padEnd(12)} ${r.description.slice(0, 50)}`)
      return { handled: true, output: "\n" + lines.join("\n") + "\n" }
    }
    case "status": {
      const id = rest[0]
      if (!id) return { handled: true, output: "uso: /task status <id>" }
      const row = await getDoc<CodeTaskDoc>("codeTasks", id)
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
      const task = await getVersionedDoc<CodeTaskDoc>("codeTasks", id)
      if (task) await (await col<CodeTaskDoc>("codeTasks")).put(id, { ...task.doc, status: "cancelled" }, { expectedVersion: task.version })
      return { handled: true, output: `  \u2713 Tarea ${id.slice(0, 8)} cancelada` }
    }
    case "rollback": {
      const id = rest[0]
      if (!id) return { handled: true, output: "uso: /task rollback <id>" }
      try {
        const task = await getVersionedDoc<CodeTaskDoc>("codeTasks", id)
        if (!task) return { handled: true, output: `  Tarea no encontrada: ${id}` }

        const snapshots = (await (await col<CodeFileSnapshotDoc>("codeFileSnapshots")).findBy("task_id", id))
          .map((entry) => entry.doc)
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

        await (await col<CodeTaskDoc>("codeTasks")).put(id, { ...task.doc, status: "cancelled" }, { expectedVersion: task.version })

        let gitMsg = ""
        if (task.doc.branch_name) {
          try {
            const proc = Bun.spawn({
              cmd: ["git", "branch", "-D", task.doc.branch_name],
              stdout: "pipe",
              stderr: "pipe",
              cwd: process.cwd(),
            })
            await proc.exited
            gitMsg = `\n  Rama ${task.doc.branch_name} eliminada.`
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
  _db: DbCompat,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action) {
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 show      \u2014 muestra \u00faltimas N entradas",
        "  \u00b7 search    \u2014 busca en el narrativo con HiveDB",
        "  \u00b7 export    \u2014 exporta narrativo completo",
        "",
      ].join("\n"),
      menu: [
        { label: "show",   cmd: "/narrative show",   desc: "muestra \u00faltimas N entradas" },
        { label: "search", cmd: "/narrative search", desc: "busca en el narrativo con HiveDB" },
        { label: "export", cmd: "/narrative export", desc: "exporta narrativo completo" },
      ],
    }
  }

  switch (action) {
    case "show": {
      const lastIdx = rest.indexOf("--last")
      const limit = lastIdx !== -1 ? parseInt(rest[lastIdx + 1] || "5", 10) : 5
      const rows = (await (await col<CodeNarrativeDoc>("codeNarrative")).scan())
        .map((entry) => entry.doc)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
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
        const needle = query.toLowerCase()
        const rows = (await (await col<CodeNarrativeDoc>("codeNarrative")).scan())
          .map((entry) => entry.doc)
          .filter((row) =>
            row.entry.toLowerCase().includes(needle) ||
            row.coordinator.toLowerCase().includes(needle) ||
            (row.phase ?? "").toLowerCase().includes(needle)
          )
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, 5)
        if (rows.length === 0) return { handled: true, output: `\n  Sin resultados para: ${query}\n` }
        const lines = rows.map(r =>
          `  \u25b8 [${r.coordinator}] ${r.created_at}\n  │  ${r.entry.slice(0, 120)}`
        )
        return { handled: true, output: "\n" + lines.join("\n\n") + "\n" }
      } catch {
        return { handled: true, output: `  \u2717 Error en b\u00fasqueda HiveDB.` }
      }
    }
    case "export": {
      const fmt = rest.includes("--format") ? rest[rest.indexOf("--format") + 1] || "md" : "md"
      const rows = (await (await col<CodeNarrativeDoc>("codeNarrative")).scan())
        .map((entry) => entry.doc)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
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
  _db: DbCompat,
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
      const pending = (await (await col<CodeTraceDoc>("codeTraces")).findBy("analyzed", false)).length
      const lastReflection = (await scanDocs<CodeReflectionDoc>("codeReflections"))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
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
        const rows = (await scanDocs<CodePlaybookDoc>("codePlaybook"))
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 10)
        if (rows.length === 0) return { handled: true, output: "\n  No hay reglas en el playbook.\n" }
        const lines = rows.map(r => {
          const icon = r.active ? "\u25cf" : "\u25cb"
          return `  ${icon}  [${(r.confidence * 100).toFixed(0)}%] ${r.rule.slice(0, 80)}`
        })
        return { handled: true, output: "\n" + lines.join("\n") + "\n" }
      }
      if (rest[0] === "reset") {
        const playbook = await col<CodePlaybookDoc>("codePlaybook")
        const rows = await playbook.scan()
        for (const row of rows) await playbook.delete(row.id)
        return { handled: true, output: "  \u2713 Playbook reiniciado" }
      }
      return { handled: true, output: "uso: /ace playbook list | /ace playbook reset" }
    }
    case "reflector": {
      if (rest[0] !== "run") {
        return { handled: true, output: "uso: /ace reflector run" }
      }
      try {
        const result = await runReflector()
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
  _db: DbCompat,
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
          await setCodeConfig("github_token", token)
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
      await deleteCodeConfig("github_token")
      return { handled: true, output: "  \u2713 GitHub desconectado" }
    }
    case "status": {
      const token = await getCodeConfig("github_token")
      return {
        handled: true,
        output: token
          ? "  \u2713 GitHub: token configurado"
          : "  \u2717 GitHub: no hay token. Configura con: hivecode github connect",
      }
    }
    case "whoami": {
      const token = await getCodeConfig("github_token")
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
      await setCodeConfig("default_repo", repo)
      return { handled: true, output: `  \u2713 Repo vinculado: ${repo}` }
    }
    default:
      return { handled: true, output: "opciones: status | whoami | set-repo\n\nEscribe /help /github" }
  }
}

async function handleSessionCommand(
  args: string[],
  _db: DbCompat,
  ctx: ContextState,
  ui?: UiCallbacks,
): Promise<CommandResult> {
  const [action, idArg] = args

  if (!action) {
    const current = ctx.sessionId && ctx.sessionId !== "none" ? ctx.sessionId.slice(0, 8) : "ninguna"
    return {
      handled: true,
      output: [
        "",
        "  \u00bfQu\u00e9 quieres hacer?",
        "  \u25b8 list     \u2014 ver sesiones recientes",
        "  \u00b7 resume   \u2014 reanudar sesi\u00f3n por id",
        "  \u00b7 new      \u2014 iniciar sesi\u00f3n nueva",
        "  \u00b7 status   \u2014 ver sesi\u00f3n activa",
        "",
        `  Sesi\u00f3n activa: ${current}`,
        "",
      ].join("\n"),
      menu: [
        { label: "list",   cmd: "/session list",   desc: "ver sesiones recientes" },
        { label: "resume", cmd: "/session resume",  desc: "reanudar sesi\u00f3n (prefijo de id)" },
        { label: "new",    cmd: "/session new",     desc: "iniciar sesi\u00f3n nueva" },
        { label: "status", cmd: "/session status",  desc: "ver sesi\u00f3n activa" },
      ],
    }
  }

  switch (action) {
    case "new": {
      const projectPath = ctx.projectPath || process.cwd()
      const newId = Bun.randomUUIDv7()
      if (ctx.sessionId && ctx.sessionId !== "none") {
        const existing = await getVersionedDoc<CodeSessionDoc>("codeSessions", ctx.sessionId)
        if (existing) {
          await (await col<CodeSessionDoc>("codeSessions")).put(ctx.sessionId, {
            ...existing.doc,
            status: "closed",
            last_active: nowIso(),
          }, { expectedVersion: existing.version })
        }
      }
      await (await col<CodeSessionDoc>("codeSessions")).put(newId, {
        id: newId,
        project_path: projectPath,
        status: "active",
        created_at: nowIso(),
        last_active: nowIso(),
      }, { expectedVersion: 0 })
      return {
        handled: true,
        output: `  \u2713 Nueva sesi\u00f3n: ${newId.slice(0, 8)}...`,
        newState: { sessionId: newId },
      }
    }

    case "list": {
      const rows = await listRecentSessionsWithTurns(15)

      if (!rows.length) return { handled: true, output: "  No hay sesiones registradas." }

      const lines = ["", "  Sesiones recientes:", ""]
      for (const r of rows) {
        const active = r.id === ctx.sessionId ? " \u25c0 activa" : ""
        const date = r.last_active.slice(0, 16).replace("T", " ")
        const project = r.project_path.split("/").pop() ?? r.project_path
        lines.push(`  ${r.id.slice(0, 8)}  ${r.status.padEnd(6)}  ${String(r.turns).padStart(3)} turnos  ${date}  ${project}${active}`)
      }
      lines.push("")
      lines.push("  Usa /session resume <id> para reanudar")
      lines.push("")
      return { handled: true, output: lines.join("\n") }
    }

    case "resume": {
      const sessions = await listRecentSessionsWithTurns(15)

      // Sin argumento: abrir modal de selecci\u00f3n si la TUI lo soporta
      if (!idArg) {
        if (ui?.showConfigModal && sessions.length > 0) {
          const options = sessions.map(s => {
            const date = s.last_active.slice(0, 16).replace("T", " ")
            const project = s.project_path.split("/").pop() ?? s.project_path
            const mark = s.id === ctx.sessionId ? " \u25c0" : ""
            return `${s.id.slice(0, 8)}  ${date}  ${project} (${s.turns} turnos)${mark}`
          })
          const values = await ui.showConfigModal("session_resume", "Reanudar Sesi\u00f3n", [
            { key: "session", label: "Sesi\u00f3n", placeholder: "", required: true, secret: false, field_type: "select", options },
          ])
          if (!values) return { handled: true, output: "  Cancelado." }
          // El valor seleccionado empieza con el id de 8 chars
          const selectedId = values["session"]?.slice(0, 8)
          if (!selectedId) return { handled: true, output: "  \u2717 Selecci\u00f3n inv\u00e1lida." }
          // Re-invocar con el id como argumento
          return handleSessionCommand(["resume", selectedId], undefined, ctx, ui)
        }
        return { handled: true, output: "  uso: /session resume <id-prefix>" }
      }

      const row = (await scanDocs<CodeSessionDoc>("codeSessions"))
        .filter((session) => session.id.startsWith(idArg))
        .sort((a, b) => b.last_active.localeCompare(a.last_active))[0] ?? null

      if (!row) return { handled: true, output: `  \u2717 No se encontr\u00f3 sesi\u00f3n con prefijo: ${idArg}` }

      if (ctx.sessionId && ctx.sessionId !== "none" && ctx.sessionId !== row.id) {
        const current = await getVersionedDoc<CodeSessionDoc>("codeSessions", ctx.sessionId)
        if (current) {
          await (await col<CodeSessionDoc>("codeSessions")).put(ctx.sessionId, {
            ...current.doc,
            status: "closed",
            last_active: nowIso(),
          }, { expectedVersion: current.version })
        }
      }
      const target = await getVersionedDoc<CodeSessionDoc>("codeSessions", row.id)
      if (target) {
        await (await col<CodeSessionDoc>("codeSessions")).put(row.id, {
          ...target.doc,
          status: "active",
          last_active: nowIso(),
        }, { expectedVersion: target.version })
      }

      const turns = (await getSessionTurns(row.id)).length
      const project = row.project_path.split("/").pop() ?? row.project_path
      return {
        handled: true,
        output: `  \u2713 Sesi\u00f3n reanudada: ${row.id.slice(0, 8)}  (${project}, ${turns} turnos)`,
        newState: { sessionId: row.id, projectPath: row.project_path },
      }
    }

    case "status": {
      const sid = ctx.sessionId
      if (!sid || sid === "none") return { handled: true, output: "  No hay sesi\u00f3n activa." }

      const row = await getDoc<CodeSessionDoc>("codeSessions", sid)

      if (!row) return { handled: true, output: `  \u2717 Sesi\u00f3n no encontrada en DB: ${sid.slice(0, 8)}` }

      const turns = (await getSessionTurns(sid)).length
      return {
        handled: true,
        output: [
          "",
          `  ID:       ${row.id.slice(0, 8)}`,
          `  Proyecto: ${row.project_path}`,
          `  Estado:   ${row.status}`,
          `  Creada:   ${row.created_at.slice(0, 16).replace("T", " ")}`,
          `  Activa:   ${row.last_active.slice(0, 16).replace("T", " ")}`,
          `  Turnos:   ${turns}`,
          "",
        ].join("\n"),
      }
    }

    default:
      return { handled: true, output: "  opciones: list | resume <id> | new | status" }
  }
}

async function handleCompactCommand(
  _db: DbCompat,
  ctx: ContextState,
): Promise<CommandResult> {
  const sessionId = ctx.sessionId
  if (!sessionId || sessionId === "none") {
    return { handled: true, output: "  No hay sesi\u00f3n activa para compactar." }
  }

  const rows = (await getSessionTurns(sessionId)).filter((turn) => turn.completed_at)

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
    const summaries = await col<SummaryDoc>("summaries")
    const existing = await summaries.get(sessionId)
    const now = Date.now()
    await summaries.put(sessionId, {
      thread_id: sessionId,
      summary,
      messages_covered: rows.length,
      last_message_id: rows[rows.length - 1]?.id ?? null,
      created_at: existing?.doc.created_at ?? now,
      updated_at: now,
    }, { expectedVersion: existing?.version ?? 0 })

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
  _db: DbCompat,
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
    await saveScratchpadNote(sessionId, key, cleanValue, isAce ? "user-ace" : "user")

    if (isAce) {
      // Propose as playbook rule with low confidence
      try {
        const playbook = await col<CodePlaybookDoc>("codePlaybook")
        const id = await nextId("codePlaybook")
        const now = new Date().toISOString()
        await playbook.put(id, {
          id,
          rule: cleanValue,
          coordinator: null,
          source: "user-note",
          helpful_count: 0,
          harmful_count: 0,
          confidence: 0.3,
          active: true,
          created_at: now,
          last_applied: null,
        }, { expectedVersion: 0 })
      } catch { /* ignore duplicate errors */ }
    }

    return { handled: true, output: `  \u2713 Nota guardada: ${key}${isAce ? " (propuesta a ACE)" : ""}` }
  }

  if (action === "list") {
    const notes = await getScratchpad(sessionId)
    if (notes.length === 0) return { handled: true, output: "  No hay notas guardadas." }
    const lines = notes.map(n => `  \u25b8 ${n.key}: ${n.value.slice(0, 60)}`)
    return { handled: true, output: "\n  Notas:\n\n" + lines.join("\n") + "\n" }
  }

  if (action === "delete") {
    if (!key) return { handled: true, output: "uso: /note delete <key>" }
    await deleteScratchpadNote(sessionId, key)
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
  _db: DbCompat,
  ui?: UiCallbacks,
): Promise<CommandResult> {
  const [action, ...rest] = args

  if (!action || action === "status") {
    const row = await getDoc<Record<string, any>>("channels", "telegram")
    if (!row || !row.active) {
      return {
        handled: true,
        output: [
          "",
          "  Telegram no configurado.",
          "",
          "  Abre ⚙ Settings → pestaña Telegram → presiona A para conectar.",
          "",
        ].join("\n"),
      }
    }
    let config: Record<string, any> = {}
    try { config = JSON.parse(row.config_encrypted as string) } catch {}
    return {
      handled: true,
      output: [
        "",
        `  Estado:      ${row.status ?? "desconocido"}`,
        `  Activo:      ${row.enabled ? "s\u00ed" : "no"}`,
        `  DM Policy:   ${config.dmPolicy ?? "\u2014"}`,
        `  Grupos:      ${config.groups ? "s\u00ed" : "no"}`,
        config.allowFrom?.length ? `  Lista blanca: ${(config.allowFrom as string[]).join(", ")}` : "",
        "",
      ].filter(Boolean).join("\n"),
    }
  }

  if (action === "disconnect") {
    try { await (Bun as any).secrets?.delete?.({ service: "hive-code", name: "telegram.bot_token" }) } catch {}
    const channels = await col<Record<string, any>>("channels")
    const row = await channels.get("telegram")
    if (row) {
      await channels.put("telegram", { ...row.doc, enabled: false, active: false, status: "disconnected" }, { expectedVersion: row.version })
    }
    return { handled: true, output: "  \u2713 Telegram desconectado" }
  }

  if (action === "connect" || action === "edit") {
    if (ui?.showConfigModal) {
      const values = await ui.showConfigModal(`telegram_${action}`, `Telegram \u2014 ${action === "connect" ? "Conectar" : "Editar"}`, [
        { key: "bot_token", label: "Bot Token",    placeholder: "123456:ABC-DEF\u2026", required: true,  secret: true,  field_type: "text" },
        { key: "dm_policy", label: "DM Policy",    placeholder: "",                required: false, secret: false, field_type: "select", options: ["open", "allowlist"] },
        { key: "groups",    label: "Grupos",        placeholder: "",                required: false, secret: false, field_type: "select", options: ["no", "s\u00ed"] },
        { key: "allow_from",label: "Lista blanca",  placeholder: "@usuario1,@usuario2", required: false, secret: false, field_type: "text" },
      ])
      if (!values) return { handled: true, output: "  Configuraci\u00f3n cancelada" }
      try {
        await (Bun as any).secrets?.set?.({ service: "hive-code", name: "telegram.bot_token", value: values.bot_token })
      } catch {}
      const configJson = JSON.stringify({
        dmPolicy: values.dm_policy || "open",
        groups: values.groups === "s\u00ed",
        allowFrom: values.allow_from ? values.allow_from.split(",").map((s: string) => s.trim()).filter(Boolean) : [],
        enabled: true,
      })
      const channels = await col<Record<string, any>>("channels")
      const existing = await channels.get("telegram")
      await channels.put("telegram", {
        ...(existing?.doc ?? {}),
        id: "telegram",
        type: "telegram",
        config_encrypted: configJson,
        active: true,
        enabled: true,
        status: "connected",
      }, { expectedVersion: existing?.version ?? 0 })
      try {
        await ui.startChannel?.("telegram", "telegram", JSON.parse(configJson))
      } catch { /* channel start is best-effort */ }
      return {
        handled: true,
        output: `  \u2713 Telegram ${action === "connect" ? "conectado" : "actualizado"}`,
      }
    }
    return {
      handled: true,
      output: [
        "",
        "  Abre \u2699 Settings \u2192 pesta\u00f1a Telegram \u2192 presiona A para configurar.",
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
  db?: DbCompat,
  ctx?: ContextState,
  ui?: UiCallbacks,
): Promise<CommandResult> {
  if (!input.startsWith("/")) {
    return { handled: false }
  }

  const ctxState = ctx ?? await getCtx()
  const parts = input.slice(1).split(/\s+/)
  const cmd = parts[0]?.toLowerCase()
  const args = parts.slice(1)

  switch (cmd) {
    case "provider":
      return handleProviderCommand(args, db, ctxState, ui)
    case "auth":
    case "login":
      return await handleAuthCommand(args, db, ctxState, ui)
    case "free":
      return await handleFreeCommand(args, db, ctxState, ui)
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
      const output = await runDoctor(db)
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
      return handleSessionCommand(args, db, ctxState, ui)
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
