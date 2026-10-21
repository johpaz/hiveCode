/**
 * El peso de un cambio: cuántas áreas toca, cuán acoplado está y si cabe en un solo worker.
 *
 * `classifyTask` decidía con expresiones regulares sobre el texto, y dos de sus señales no
 * decían nada del cambio: la forma de la frase («crea un proyecto») y la longitud del
 * enunciado (> 600 caracteres). Con eso, un contrato preciso y detallado —el tipo de enunciado
 * que hace la tarea más fácil— mandaba a la ruta más cara: el enjambre completo para escribir
 * un CLI de cinco comandos (medido el 21-oct-2026: 9 runs, 1,9 M de tokens en 14 minutos).
 *
 * Aquí el peso se estima por lo que de verdad cuesta el cambio: las áreas que toca, lo
 * acoplado que está y si el trabajo cabe en un worker. La longitud del enunciado pesa, pero
 * al revés: un enunciado detallado es evidencia de que la tarea está acotada.
 *
 * Ver `docs/rutas-por-costo.md`.
 */
import { existsSync, readFileSync, readdirSync, statSync, type Stats } from "node:fs"
import { join } from "node:path"

export type TaskTier = "conversation" | "scoped" | "feature"

export interface StatementSignals {
  /** Hay una orden de mutar algo (no es una pregunta). */
  mutating: boolean
  /** Señales que, por sí solas, justifican partir el trabajo en varios workers. */
  coupled: string[]
  /** Áreas distintas que el enunciado menciona. */
  areas: string[]
  /** Artefactos que el enunciado enumera (comandos, endpoints, ficheros, rutas). */
  deliverables: number
  /** El enunciado pide algo nuevo desde cero: no hay nada que acoplar ni que romper. */
  greenfield: boolean
}

export interface ProjectFacts {
  /** Ficheros del workspace, sin contar node_modules ni .git. */
  files: number
  /** Directorios de primer nivel con código: cada uno es un módulo. */
  modules: number
  hasTests: boolean
  /** Hay configuración de TypeScript: sin ella no hay tipos que comprobar. */
  hasTypescript: boolean
  /** Las dependencias están instaladas: sin ellas, la comprobación mide el entorno. */
  hasDependencies: boolean
  hasPackageJson: boolean
  scripts: string[]
  /** El gestor de paquetes que indica el lockfile, si hay uno. */
  packageManager?: "bun" | "pnpm" | "yarn" | "npm"
}

const LOCKFILES: [string, NonNullable<ProjectFacts["packageManager"]>][] = [
  ["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"],
]

/**
 * Lo que el agente necesita saber del proyecto para no gastar turnos averiguándolo: cómo se
 * ejecuta, qué hay y qué comprobará el harness al final. `checks` son las etiquetas de lo que
 * el harness ejecutará solo (ver `checksFor`). Devuelve "" si no hay nada que decir.
 */
export function describeProjectFacts(facts: ProjectFacts | undefined, checks: string[] = []): string {
  if (!facts || (facts.files === 0 && !facts.hasPackageJson)) return ""
  const run = facts.packageManager === "bun" ? "bun run" : facts.packageManager === "pnpm" ? "pnpm run" : facts.packageManager === "yarn" ? "yarn" : facts.packageManager === "npm" ? "npm run" : undefined
  const lines = [
    "Proyecto (ya inspeccionado: no lo explores para averiguar esto):",
    `- ${facts.files} ficheros, ${facts.modules} directorios de primer nivel con código`,
  ]
  if (facts.packageManager) lines.push(`- gestor de paquetes: ${facts.packageManager}`)
  if (facts.scripts.length) lines.push(`- scripts de package.json: ${facts.scripts.map(s => (run ? `${run} ${s}` : s)).join(", ")}`)
  lines.push(`- pruebas: ${facts.hasTests ? "sí" : "no hay"} · tsconfig: ${facts.hasTypescript ? "sí" : "no hay"} · dependencias instaladas: ${facts.hasPackageJson ? (facts.hasDependencies ? "sí" : "no") : "n/a"}`)
  if (checks.length) lines.push(`- al terminar, el harness ejecuta solo (${checks.join(", ")}): corre antes tú solo lo que toca tu cambio, no el proyecto entero`)
  else lines.push("- no hay nada que el harness pueda ejecutar solo al terminar (sin pruebas, tipos ni build): comprueba tu cambio tú")
  return lines.join("\n")
}

export interface TaskWeight {
  tier: TaskTier
  /** Puntuación 0-100. Sólo sirve para explicar la decisión, no para decidirla. */
  score: number
  /** Por qué se eligió esta ruta, en palabras. Va al informe de la tarea. */
  signals: string[]
  statement: StatementSignals
  project?: ProjectFacts
}

/** Verbos de mutación en imperativo o infinitivo, español e inglés. */
const MUTATION_VERBS = [
  "implement", "implementa", "implementar", "fix", "corrige", "corregir", "arregla", "arreglar",
  "cambia", "cambiar", "change", "add", "agrega", "agregar", "añade", "añadir",
  "crea", "creas", "crear", "create", "remove", "elimina", "eliminar",
  "borra", "borrar", "delete", "quita", "quitar", "renombra", "renombrar", "rename",
  "mueve", "mover", "move", "modifica", "modificar", "edita", "editar", "escribe", "escribir", "write",
  "actualiza", "actualizar", "update", "reemplaza", "reemplazar", "replace",
  "refactor", "refactoriza", "refactorizar", "instala", "instalar", "install",
  "construye", "construir", "build", "desarrolla", "desarrollar", "develop", "scaffold",
  // Planificar, migrar y diseñar son órdenes de cambio aunque no toquen un fichero todavía:
  // "planifica la migración de arquitectura" es una tarea de feature, no una conversación.
  "planifica", "planificar", "plan", "diseña", "diseñar", "migra", "migrar", "migrate",
  "optimiza", "optimizar", "mejora", "mejorar", "documenta", "documentar", "estructura", "estructurar",
]

/**
 * Señales de acoplamiento. Cada una significa que el cambio cruza fronteras del código y
 * por eso necesita más de un worker o un plan antes de tocar nada.
 */
const COUPLED_SIGNALS: [string, RegExp][] = [
  ["arquitectura", /\b(architecture|arquitectura)\b/],
  ["migración", /\b(migration|migraci[oó]n|migrate|migrar)\b/],
  ["esquema de datos", /\b(database schema|esquema de base de datos|schema change)\b/],
  ["refactor amplio", /\b(large refactor|refactor amplio|wide refactor)\b/],
  ["funcionalidad nueva", /\b(new feature|nueva funcionalidad|nuevo m[oó]dulo|new module)\b/],
  ["varios módulos", /\b(multi[- ]module|multi[- ]m[oó]dulo|cross[- ]cutting|cross[- ]m[oó]dulo)\b/],
  ["cambio incompatible", /\b(breaking change|cambio incompatible)\b/],
  ["rediseño", /\b(redesign|rediseñ[oa])\b/],
  ["autenticación", /\b(authentication|authentication|autorizaci[oó]n|autenticaci[oó]n)\b/],
  ["permisos", /\b(permissions|permisos|roles y permisos)\b/],
]

/** Áreas del sistema. Cada una mentioned en el enunciado es un módulo distinto que tocar. */
const AREA_SIGNALS: [string, RegExp][] = [
  ["api", /\b(api|rest|endpoints?|server|servidor|backend)\b/],
  ["frontend", /\b(frontend|front-end|interfaz|ui|html|css|p[aá]gina|web)/],
  ["datos", /\b(base de datos|databases?|persistencia|storage|sqlite|postgres|mongo)\b/],
  ["infra", /\b(deploy|despliegue|docker|ci\/cd|github actions|kubernetes|terraform)\b/],
  ["docs", /\b(documentaci[oó]n|documentaci[oó]n|readme|docs\b|manual)/],
  ["tests", /\b(suite de pruebas|tests? unitarios|e2e|end-to-end|playwright|cypress)\b/],
]

/** Enumeraciones explícitas: «5 comandos», «3 endpoints», «un archivo». */
const DELIVERABLE_PATTERNS: RegExp[] = [
  /\b(\d{1,2})\s+(comandos?|endpoints?|rutas?|ficheros?|archivos?|m[oó]dulos?|tablas?|pantallas?)\b/g,
  /\b(\d{1,2})\s+(commands?|endpoints?|routes?|files?|modules?)\b/g,
]

const GREENFIELD = /\b(crea(?:r|s)?\s+(?:un|una)\s+(proyecto|app|aplicaci[oó]n|sitio)|create\s+(?:a\s+)?(new\s+)?(project|app)|from scratch|en el directorio actual|in the current directory)\b/

/** Lee el enunciado y separa las señales que importan. Síncrono y puro: sin E/S. */
export function analyzeStatement(objective: string): StatementSignals {
  const text = objective.trim().toLowerCase()
  const mutationRe = new RegExp(`\\b(?:${MUTATION_VERBS.join("|")})\\b`)
  const mutating = mutationRe.test(text)

  const coupled = COUPLED_SIGNALS.filter(([, re]) => re.test(text)).map(([name]) => name)
  const areas = AREA_SIGNALS.filter(([, re]) => re.test(text)).map(([name]) => name)

  // Artefactos enumerados: los números explícitos y las listas numeradas del contrato.
  let deliverables = 0
  for (const pattern of DELIVERABLE_PATTERNS) {
    for (const match of text.matchAll(pattern)) deliverables = Math.max(deliverables, Number(match[1]) || 0)
  }
  const numbered = (text.match(/^\s*\d{1,2}[.)]\s+/gm) ?? []).length
  deliverables = Math.max(deliverables, numbered)

  return {
    mutating,
    coupled,
    areas,
    deliverables,
    greenfield: GREENFIELD.test(text),
  }
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", "coverage", ".cache"])

/**
 * Los hechos del proyecto que el enunciado no puede saber: cuántos ficheros hay, cuántos
 * módulos, si hay suite de pruebas y qué scripts ofrece. Barato: un recorrido con tope.
 */
export function readProjectFacts(workspace: string): ProjectFacts {
  const facts: ProjectFacts = { files: 0, modules: 0, hasTests: false, hasTypescript: false, hasDependencies: false, hasPackageJson: false, scripts: [] }
  if (!workspace || !existsSync(workspace)) return facts

  const stack: string[] = [workspace]
  let visited = 0
  while (stack.length && visited < 400) {
    const dir = stack.pop()!
    visited++
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let stat: Stats | null = null
      try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory()) {
        if (dir === workspace) facts.modules++
        if (entry === "tests" || entry === "test" || entry === "__tests__" || entry === "spec") facts.hasTests = true
        stack.push(full)
      } else if (stat.isFile()) {
        facts.files++
        if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) facts.hasTests = true
        if (entry === "package.json") facts.hasPackageJson = true
      }
    }
  }

  try {
    const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf-8"))
    facts.scripts = Object.keys(pkg.scripts ?? {})
    facts.hasTests = facts.hasTests || "test" in (pkg.scripts ?? {})
    facts.hasPackageJson = true
  } catch { /* sin package.json: nada que leer */ }

  // Los tipos sólo se comprueban si hay configuración: `tsc` sin `tsconfig` no dice nada
  // útil del código, así que su fallo no sería evidencia de nada.
  facts.hasTypescript = existsSync(join(workspace, "tsconfig.json"))
    || existsSync(join(workspace, "jsconfig.json"))
  // Sin node_modules, una comprobación mide el entorno (tipos que no están instalados), no el
  // código: su rojo sería una evidencia inventada.
  facts.hasDependencies = existsSync(join(workspace, "node_modules"))
  facts.packageManager = LOCKFILES.find(([file]) => existsSync(join(workspace, file)))?.[1]

  return facts
}

/**
 * Decide la ruta. El orden importa: primero la intención (¿hay que mutar?), después el
 * acoplamiento y el breadth, y por último el tamaño del proyecto como contexto.
 */
export function decideTier(statement: StatementSignals, project?: ProjectFacts): { tier: TaskTier; score: number; signals: string[] } {
  const signals: string[] = []
  let score = 0

  if (!statement.mutating) {
    return { tier: "conversation", score: 0, signals: ["no hay orden de mutar"] }
  }
  signals.push("hay una orden de mutar")

  for (const name of statement.coupled) {
    score += 35
    signals.push(`acoplado: ${name}`)
  }

  if (statement.areas.length >= 3) {
    score += 30
    signals.push(`toca ${statement.areas.length} áreas: ${statement.areas.join(", ")}`)
  } else if (statement.areas.length === 2) {
    score += 10
    signals.push(`toca 2 áreas: ${statement.areas.join(", ")}`)
  }

  if (statement.greenfield) {
    score -= 15
    signals.push("proyecto nuevo desde cero")
  }

  if (project) {
    if (project.files >= 60 && statement.areas.length >= 2) {
      score += 25
      signals.push(`proyecto grande (${project.files} ficheros) y cambio en ${statement.areas.length} áreas`)
    } else if (project.files >= 60) {
      score += 5
      signals.push(`proyecto grande (${project.files} ficheros)`)
    }
    if (!project.hasTests && !statement.greenfield) {
      score += 10
      signals.push("el proyecto no tiene suite de pruebas: el cambio no se puede verificar")
    }
    if (project.hasTests) signals.push("el proyecto tiene suite de pruebas: el resultado se puede verificar")
  }

  const tier: TaskTier = score >= 45 ? "feature" : "scoped"
  signals.push(`puntuación ${score} → ruta ${tier}`)
  return { tier, score, signals }
}

/** La decisión completa: enunciado + proyecto. */
export async function estimateTaskWeight(objective: string, workspace?: string): Promise<TaskWeight> {
  const statement = analyzeStatement(objective)
  const project = workspace ? readProjectFacts(workspace) : undefined
  const { tier, score, signals } = decideTier(statement, project)
  return { tier, score, signals, statement, project }
}
