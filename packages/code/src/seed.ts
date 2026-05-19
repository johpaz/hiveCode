/**
 * Hive-Code Seed — datos predeterminados para el módulo de código.
 *
 * Se ejecuta automáticamente al iniciar el servicio (CLI o gateway).
 * Idempotente: usa INSERT OR REPLACE para no perder cambios del usuario.
 */

import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import { BUNDLED_SKILLS_DATA } from "../../skills/src/bundled-data.generated"

const log = logger.child("code-seed")

// ─── 1. Code Tools (16 herramientas de código) ───────────────────────────────

interface CodeToolSeed {
  id: string
  name: string
  description: string
}

const CODE_TOOLS: CodeToolSeed[] = [
  { id: "git_status", name: "git_status", description: "Show working tree status (git status --porcelain). Returns changed, staged, and untracked files. Spanish: estado git, cambios, staged" },
  { id: "git_diff", name: "git_diff", description: "Show changes in working tree or between commits (git diff). Spanish: ver cambios, diff, comparar" },
  { id: "git_log", name: "git_log", description: "Show commit history (git log). Spanish: historial commits, log git" },
  { id: "git_branch", name: "git_branch", description: "List, create, or delete git branches. Spanish: ramas git, branch, crear rama" },
  { id: "git_commit", name: "git_commit", description: "Stage files and create a git commit. Spanish: commit, confirmar cambios" },
  { id: "code_search", name: "code_search", description: "Search codebase for patterns using ripgrep or grep. Spanish: buscar codigo, grep, encontrar en codigo" },
  { id: "code_build", name: "code_build", description: "Run build command for the project. Auto-detects package.json. Spanish: compilar, build, bun run build" },
  { id: "code_test", name: "code_test", description: "Run test suites. Auto-detects test scripts. Spanish: ejecutar tests, pruebas, bun test" },
  { id: "code_lint", name: "code_lint", description: "Run linter. Auto-detects ESLint, Ruff. Spanish: linter, eslint, calidad codigo" },
  { id: "code_diff_create", name: "code_diff_create", description: "Generate unified diff between files/versions. Spanish: crear diff, parche, patch" },
  { id: "parse_ast", name: "parse_ast", description: "Analyze AST using Bun.Transpiler. Returns imports, exports, functions. Spanish: analizar ast, parsear codigo" },
  { id: "check_types", name: "check_types", description: "Run TypeScript type checking (tsc --noEmit). Spanish: revisar tipos, typecheck, tsc" },
  { id: "run_script", name: "run_script", description: "Run a package.json script. Spanish: ejecutar script, npm run, bun run" },
  { id: "git_blame", name: "git_blame", description: "Show line-by-line author info (git blame). Spanish: blame, autor linea" },
  { id: "git_create_pr", name: "git_create_pr", description: "Create GitHub Pull Request via API. Spanish: crear pr, pull request, github pr" },
  { id: "git_rollback", name: "git_rollback", description: "Restore files to pre-task state from snapshots. Spanish: rollback, restaurar, deshacer" },
]

// ─── 2. Code Playbook Rules (reglas de seguridad y calidad) ──────────────────

interface PlaybookRuleSeed {
  rule: string
  category: "tool_selection" | "response_quality" | "error_avoidance" | "optimization" | "agent_creation"
  applicable_to: string
}

const CODE_PLAYBOOK_RULES: PlaybookRuleSeed[] = [
  {
    rule: "Siempre verificar con read_file antes de edit_file — oldStr debe aparecer exactamente 1 vez",
    category: "error_avoidance",
    applicable_to: JSON.stringify(["backend", "frontend", "security", "test"]),
  },
  {
    rule: "Nunca escribir credenciales en código — siempre usar Bun.secrets o variables de entorno",
    category: "error_avoidance",
    applicable_to: JSON.stringify(["backend", "frontend", "security", "devops"]),
  },
  {
    rule: "Ejecutar check_types después de cambios TypeScript para detectar errores temprano",
    category: "tool_selection",
    applicable_to: JSON.stringify(["backend", "frontend", "test"]),
  },
  {
    rule: "En PLAN mode, solo tools de lectura están permitidas — ninguna escritura",
    category: "tool_selection",
    applicable_to: JSON.stringify(["architecture", "backend", "frontend", "security", "test", "devops"]),
  },
  {
    rule: "Crear snapshot antes de cada escritura de archivo para permitir rollback",
    category: "error_avoidance",
    applicable_to: JSON.stringify(["backend", "frontend", "security", "test", "devops"]),
  },
  {
    rule: "Usar Bun.randomUUIDv7() en vez de crypto.randomUUID() para mejor ordenamiento en SQLite",
    category: "optimization",
    applicable_to: JSON.stringify(["backend", "frontend", "devops"]),
  },
  {
    rule: "Delegar a sub-agentes cuando la tarea excede 3 archivos o requiere expertise especializado",
    category: "agent_creation",
    applicable_to: JSON.stringify(["architecture", "backend", "frontend"]),
  },
  {
    rule: "En modo APPROVAL, mostrar preview exacto de archivos que se crearán o modificarán",
    category: "response_quality",
    applicable_to: JSON.stringify(["architecture", "backend", "frontend", "security", "test", "devops"]),
  },
]

// ─── Seed Functions ──────────────────────────────────────────────────────────

function seedCodeTools(): void {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tools (id, name, description, category, enabled, active, created_at, updated_at)
    VALUES (?, ?, ?, 'code', 1, 1, unixepoch(), unixepoch())
  `)

  let count = 0
  for (const tool of CODE_TOOLS) {
    try {
      stmt.run(tool.id, tool.name, tool.description)
      count++
    } catch (err) {
      log.warn(`Failed to seed tool ${tool.id}:`, (err as Error).message)
    }
  }

  log.info(`[seed] ✅ ${count} code tools seeded`)
}

function seedCodeSkills(): void {
  const db = getDb()

  // Filter code-related skills from bundled data
  const codeSkills = BUNDLED_SKILLS_DATA.filter(
    (s) => s.category === "code" || s.category === "git"
  )

  if (codeSkills.length === 0) {
    log.warn("[seed] ⚠️  No code skills found in bundled data")
    return
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO skills (
      id, name, description, version, author, icon, category,
      permissions, dependencies, tools, triggers, preferred_agents,
      body, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Hive-Code', '💻', ?, null, null, ?, ?, null, ?, 1, datetime('now'), datetime('now'))
  `)

  let count = 0
  for (const skill of codeSkills) {
    try {
      stmt.run(
        skill.name,
        skill.name,
        skill.description,
        skill.version,
        skill.category,
        JSON.stringify(skill.tools),
        JSON.stringify(skill.triggers),
        skill.body
      )
      count++
    } catch (err) {
      log.warn(`Failed to seed skill ${skill.name}:`, (err as Error).message)
    }
  }

  log.info(`[seed] ✅ ${count} code skills seeded`)
}

function seedCodePlaybook(): void {
  const db = getDb()

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO playbook (rule, category, applicable_to, helpful_count, harmful_count, active, created_at)
    VALUES (?, ?, ?, 1, 0, 1, unixepoch())
  `)

  let count = 0
  for (const rule of CODE_PLAYBOOK_RULES) {
    try {
      stmt.run(rule.rule, rule.category, rule.applicable_to)
      count++
    } catch (err) {
      log.warn(`Failed to seed playbook rule:`, (err as Error).message)
    }
  }

  log.info(`[seed] ✅ ${count} code playbook rules seeded`)

  // Sync to FTS5
  try {
    db.run(`DELETE FROM playbook_fts`)
    const ftsStmt = db.prepare(`INSERT INTO playbook_fts(rule, category, applicable_to) VALUES (?, ?, ?)`)
    for (const rule of CODE_PLAYBOOK_RULES) {
      ftsStmt.run(rule.rule, rule.category, rule.applicable_to)
    }
    log.info(`[seed] ✅ ${count} playbook rules synced to fts5`)
  } catch (err) {
    log.warn("Failed to sync playbook to fts5:", (err as Error).message)
  }
}

// ─── 3. Commands FTS (autocomplete for slash commands) ─────────────────────

interface CommandSeed {
  command: string
  category: string
  description: string
}

const INTERNAL_COMMANDS: CommandSeed[] = [
  { command: "/provider list", category: "provider", description: "Muestra providers configurados + modelo activo" },
  { command: "/provider add", category: "provider", description: "Agrega nuevo provider" },
  { command: "/provider set", category: "provider", description: "Cambia provider activo" },
  { command: "/provider test", category: "provider", description: "Ping al provider, mide latencia" },
  { command: "/provider status", category: "provider", description: "Estado de todos los providers" },
  { command: "/modelo list", category: "modelo", description: "Lista modelos disponibles por provider" },
  { command: "/modelo set", category: "modelo", description: "Cambia modelo activo" },
  { command: "/modelo info", category: "modelo", description: "Detalles del modelo" },
  { command: "/mcp list", category: "mcp", description: "Lista MCPs conectados/desconectados" },
  { command: "/mcp add", category: "mcp", description: "Registra nuevo MCP" },
  { command: "/mcp enable", category: "mcp", description: "Activa MCP en sesión actual" },
  { command: "/mcp disable", category: "mcp", description: "Desactiva sin eliminar config" },
  { command: "/mcp test", category: "mcp", description: "Verifica conexión y lista tools" },
  { command: "/skill list", category: "skill", description: "Lista skills: built-in / custom / active" },
  { command: "/skill enable", category: "skill", description: "Activa skill" },
  { command: "/skill disable", category: "skill", description: "Desactiva sin eliminar" },
  { command: "/skill info", category: "skill", description: "Muestra contenido y metadata" },
  { command: "/skill add", category: "skill", description: "Importa skill desde archivo .md" },
  { command: "/mode get", category: "mode", description: "Muestra modo actual" },
  { command: "/mode set", category: "mode", description: "Cambia modo Plan/Approval/Auto" },
  { command: "/mode history", category: "mode", description: "Historial de cambios de modo" },
  { command: "/task list", category: "task", description: "Tareas recientes" },
  { command: "/task status", category: "task", description: "Estado detallado + fase actual" },
  { command: "/task cancel", category: "task", description: "Cancela tarea en curso" },
  { command: "/task rollback", category: "task", description: "Reviente cambios de una tarea" },
  { command: "/narrative show", category: "narrative", description: "Muestra últimas N entradas del narrativo" },
  { command: "/narrative search", category: "narrative", description: "Busca en el narrativo por FTS5" },
  { command: "/narrative export", category: "narrative", description: "Exporta narrativo completo" },
  { command: "/ace status", category: "ace", description: "Estado del aprendizaje adaptativo" },
  { command: "/ace playbook list", category: "ace", description: "Reglas aprendidas (activas + inactivas)" },
  { command: "/ace playbook reset", category: "ace", description: "Borra playbook y reinicia aprendizaje" },
  { command: "/ace reflector run", category: "ace", description: "Fuerza análisis inmediato" },
  { command: "/github status", category: "github", description: "Verifica token válido y permisos" },
  { command: "/github whoami", category: "github", description: "Muestra usuario autenticado" },
  { command: "/github set-repo", category: "github", description: "Vincula a repo específico" },
  { command: "/doctor", category: "system", description: "Chequeo completo del sistema" },
  { command: "/version", category: "system", description: "Muestra versión + commit hash" },
  { command: "/env", category: "system", description: "Muestra variables de entorno no sensibles" },
  { command: "/help", category: "system", description: "Muestra ayuda categorizada" },
]

function seedCommandsFts(): void {
  const db = getDb()

  try {
    db.run("DELETE FROM code_commands_fts")
    const stmt = db.prepare("INSERT INTO code_commands_fts(command, category, description) VALUES (?, ?, ?)")
    for (const cmd of INTERNAL_COMMANDS) {
      stmt.run(cmd.command, cmd.category, cmd.description)
    }
    log.info(`[seed] ✅ ${INTERNAL_COMMANDS.length} internal commands indexed for FTS5`)
  } catch (err) {
    log.warn("[seed] ⚠️  Failed to seed commands FTS:", (err as Error).message)
  }
}

// ─── 4. Coordinators (6 roles fijos del sistema) ─────────────────────────────

interface CoordinatorSeed {
  id: string
  name: string
  description: string
  prompt: string
}

const COORDINATOR_SEED: CoordinatorSeed[] = [
  {
    id: "coord-bee",
    name: "bee",
    description: "BEE — Senior Dev: punto de entrada único, entiende la intención del usuario y decide qué agentes llamar",
    prompt: "Eres BEE, el Senior Developer de Hive-Code. Eres el primer agente que recibe todas las solicitudes. Clasifica la intención del usuario y decide si responder directamente, aplicar un fix simple, o escalar a los coordinadores especializados (Architecture, Backend, Frontend, Security, Test, DevOps).",
  },
  {
    id: "coord-architecture",
    name: "architecture",
    description: "Arquitecto: analiza requisitos, diseña arquitectura y crea el plan de implementación por fases",
    prompt: "Eres el coordinador Architecture de Hive-Code. Tu responsabilidad es analizar el proyecto, diseñar la arquitectura de software e identificar los componentes necesarios. Crea un plan detallado de implementación dividido en fases asignadas a los coordinadores backend, frontend, security, test y devops.",
  },
  {
    id: "coord-backend",
    name: "backend",
    description: "Backend engineer: implementa APIs, lógica de negocio, modelos de datos y servicios",
    prompt: "Eres el coordinador Backend de Hive-Code. Implementa la lógica del servidor, APIs REST/GraphQL, modelos de base de datos, servicios e integraciones con sistemas externos. Usa las herramientas disponibles para leer, escribir y verificar código.",
  },
  {
    id: "coord-frontend",
    name: "frontend",
    description: "Frontend engineer: implementa UI, componentes, estilos y experiencia de usuario",
    prompt: "Eres el coordinador Frontend de Hive-Code. Implementa la interfaz de usuario, componentes visuales, estilos, animaciones y experiencia del usuario. Garantiza accesibilidad y rendimiento.",
  },
  {
    id: "coord-security",
    name: "security",
    description: "Security engineer: audita código, detecta vulnerabilidades e implementa controles de seguridad",
    prompt: "Eres el coordinador Security de Hive-Code. Audita el código en busca de vulnerabilidades (OWASP Top 10), implementa controles de seguridad, gestiona autenticación, autorización y protección de datos sensibles.",
  },
  {
    id: "coord-test",
    name: "test",
    description: "QA engineer: diseña y ejecuta pruebas unitarias, de integración y end-to-end",
    prompt: "Eres el coordinador Test de Hive-Code. Diseña y ejecuta suites de pruebas unitarias, de integración y end-to-end. Garantiza cobertura adecuada del código y verifica el correcto funcionamiento del sistema.",
  },
  {
    id: "coord-devops",
    name: "devops",
    description: "DevOps engineer: configura CI/CD, Docker, despliegues y monitoreo",
    prompt: "Eres el coordinador DevOps de Hive-Code. Configura pipelines CI/CD, dockerización, infraestructura como código, estrategias de despliegue y sistemas de monitoreo.",
  },
]

function seedCodeCoordinators(): void {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents (id, name, description, system_prompt, role, status, enabled)
    VALUES (?, ?, ?, ?, 'coordinator', 'idle', 1)
  `)

  let count = 0
  for (const c of COORDINATOR_SEED) {
    try {
      stmt.run(c.id, c.name, c.description, c.prompt)
      count++
    } catch (err) {
      log.warn(`[seed] Failed to seed coordinator ${c.id}:`, (err as Error).message)
    }
  }

  log.info(`[seed] ✅ ${count} coordinadores seeded`)
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function seedCodeData(force = false): void {
  const db = getDb()
  
  if (!force) {
    const existing = db.query("SELECT COUNT(*) as c FROM agents WHERE role='coordinator' LIMIT 1").get() as { c: number }
    if (existing && existing.c > 0) {
      log.debug("[seed] ⚡ Datos de Hive-Code ya existentes, saltando seed")
      return
    }
  }

  log.info("[seed] 🌱 Seeding Hive-Code data...")

  try {
    seedCodeTools()
    seedCodeSkills()
    seedCodePlaybook()
    seedCommandsFts()
    seedCodeCoordinators()
    log.info("[seed] ✨ Hive-Code seed completed")
  } catch (err) {
    log.error("[seed] ❌ Hive-Code seed failed:", (err as Error).message)
  }
}
