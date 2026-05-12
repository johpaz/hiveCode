/**
 * Hive-Code Seed — datos predeterminados para el módulo de código.
 *
 * Se ejecuta automáticamente al iniciar el servicio (CLI o gateway).
 * Idempotente: usa INSERT OR REPLACE para no perder cambios del usuario.
 */

import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { logger } from "@johpaz/hive-code-core/utils/logger"
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

// ─── Public API ──────────────────────────────────────────────────────────────

export function seedCodeData(): void {
  log.info("[seed] 🌱 Seeding Hive-Code data...")

  try {
    seedCodeTools()
    seedCodeSkills()
    seedCodePlaybook()
    log.info("[seed] ✨ Hive-Code seed completed")
  } catch (err) {
    log.error("[seed] ❌ Hive-Code seed failed:", (err as Error).message)
  }
}
