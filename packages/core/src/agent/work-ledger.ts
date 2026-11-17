/**
 * Libro de trabajo — lo que se hizo en un hilo, derivado del registro de herramientas. Sin modelo.
 *
 * Es una PROYECCIÓN, en el sentido de HiveDB: el estado se deriva de un registro inmutable con una función
 * pura y determinista (mismo registro, mismo libro). Aquí el registro es `toolRuns`, que el bucle del agente ya
 * escribe en cada llamada (herramienta, argumentos, estado, error, si modificó el workspace): no añade escrituras
 * al camino caliente ni llamadas al modelo.
 *
 * Responde, con datos y no con prosa, lo que un resumen de modelo suele perder o inventar: qué archivos se
 * tocaron, qué comprobaciones pasan o fallan ahora, qué intentos ya fallaron y no deben repetirse. Es el
 * equivalente determinista de los campos «cambios», «verificación» y «callejones sin salida» del traspaso de
 * «You don't need long context» (arXiv 2611.05306). El objetivo y el plan no se derivan de las herramientas:
 * ya están en la tarea, en Spec Kit y en las notas del agente.
 */

import { col } from "../storage/hive"
import type { ToolRunDoc } from "../storage/collections"

/** Herramientas que comprueban el estado del proyecto: interesa el último resultado de cada una. */
const CHECK_TOOLS = new Set(["code_test", "code_test_parallel", "check_types", "code_build", "code_lint"])
/** Herramientas de shell: se listan los últimos comandos, no todos. */
const COMMAND_TOOLS = new Set(["shell_executor", "run_script"])

// Tope defensivo: un hilo con miles de llamadas no debe convertir cada turno en un recorrido sin fin.
const MAX_TOOL_RUNS = 5_000
const MAX_FILES = 40
const MAX_COMMANDS = 6
const MAX_DEAD_ENDS = 8
const ERROR_CHARS = 160
const TARGET_CHARS = 120
const DEFAULT_MAX_CHARS = 2_400

export interface LedgerCommand { command: string; ok: boolean; error?: string }
export interface LedgerCheck { tool: string; ok: boolean; error?: string }
export interface LedgerDeadEnd { tool: string; target: string; error: string; times: number }

export interface WorkLedger {
  /** Archivos que alguna herramienta modificó, en orden de aparición. */
  changed: string[]
  /** Archivos que se leyeron y no se modificaron. */
  read: string[]
  /** Último resultado de cada comprobación (pruebas, tipos, compilación, lint). */
  checks: LedgerCheck[]
  /** Los últimos comandos de shell. */
  commands: LedgerCommand[]
  /** Intentos que fallaron y no se repitieron con éxito después. */
  deadEnds: LedgerDeadEnd[]
  calls: number
  failures: number
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Rutas que nombra una llamada (`path`, `file_path`, `paths`…), vacías si no nombra ninguna. */
function pathsOf(args: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const v = args[key]
    if (typeof v === "string" && v.trim()) out.push(v.trim())
  }
  for (const key of ["paths", "files"]) {
    const v = args[key]
    if (Array.isArray(v)) for (const item of v) if (typeof item === "string" && item.trim()) out.push(item.trim())
  }
  return out
}

/** Primera línea útil de un error, acotada. */
function firstLine(text: string | null | undefined): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? ""
  return line.length > ERROR_CHARS ? `${line.slice(0, ERROR_CHARS)}…` : line
}

/** Firma estable de una llamada: la misma herramienta con los mismos argumentos es el mismo intento. */
function signature(tool: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args).sort().map((k) => [k, args[k]])
  return `${tool}:${JSON.stringify(sorted)}`
}

function describeTarget(args: Record<string, unknown>): string {
  const paths = pathsOf(args)
  const raw = paths[0] ?? (typeof args.command === "string" ? args.command : "") ?? ""
  const text = String(raw).replace(/\s+/g, " ").trim()
  return text.length > TARGET_CHARS ? `${text.slice(0, TARGET_CHARS)}…` : text
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

/** Construye el libro de un conjunto de llamadas. Pura: no lee la base ni el reloj. */
export function buildWorkLedger(runs: ToolRunDoc[]): WorkLedger {
  // Solo llamadas terminadas, en el orden en que empezaron.
  const done = runs
    .filter((r) => r.status === "completed" || r.status === "failed")
    .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0) || a.id.localeCompare(b.id))

  const changed: string[] = []
  const read: string[] = []
  const checks = new Map<string, LedgerCheck>()
  const commands: LedgerCommand[] = []
  // firma → último intento fallido, y marca de si luego hubo éxito con la misma firma.
  const failed = new Map<string, LedgerDeadEnd & { recovered: boolean }>()
  let failures = 0

  for (const run of done) {
    const args = parseArgs(run.args_json)
    const ok = run.status === "completed"
    const sig = signature(run.tool_name, args)
    const prior = failed.get(sig)

    if (ok) {
      if (prior) prior.recovered = true
    } else {
      failures++
      const error = firstLine(run.error) || firstLine(run.result_json)
      if (prior && !prior.recovered) {
        prior.times++
        prior.error = error || prior.error
      } else {
        failed.set(sig, { tool: run.tool_name, target: describeTarget(args), error, times: 1, recovered: false })
      }
    }

    if (ok && run.mutates_workspace) {
      for (const p of pathsOf(args)) pushUnique(changed, p)
    } else if (ok && run.read_only) {
      for (const p of pathsOf(args)) pushUnique(read, p)
    }

    if (CHECK_TOOLS.has(run.tool_name)) {
      checks.set(run.tool_name, { tool: run.tool_name, ok, ...(ok ? {} : { error: firstLine(run.error) || firstLine(run.result_json) }) })
    }
    if (COMMAND_TOOLS.has(run.tool_name)) {
      const command = typeof args.command === "string" ? args.command : describeTarget(args)
      commands.push({
        command: command.replace(/\s+/g, " ").trim().slice(0, TARGET_CHARS),
        ok,
        ...(ok ? {} : { error: firstLine(run.error) || firstLine(run.result_json) }),
      })
    }
  }

  const deadEnds = [...failed.values()]
    .filter((d) => !d.recovered)
    .map(({ recovered: _recovered, ...rest }) => rest)
    .slice(-MAX_DEAD_ENDS)

  return {
    changed,
    // Lo que se modificó ya no es «solo leído».
    read: read.filter((p) => !changed.includes(p)),
    checks: [...checks.values()],
    commands: commands.slice(-MAX_COMMANDS),
    deadEnds,
    calls: done.length,
    failures,
  }
}

function listFiles(label: string, files: string[]): string {
  if (files.length === 0) return ""
  const shown = files.slice(-MAX_FILES)
  const extra = files.length - shown.length
  return `${label}: ${shown.join(", ")}${extra > 0 ? ` (+${extra} más)` : ""}`
}

/**
 * El libro como texto para el prompt, en orden de prioridad: si hay que recortar, se pierde lo último.
 * Vacío si no hay nada que contar.
 */
export function renderWorkLedger(ledger: WorkLedger, maxChars = DEFAULT_MAX_CHARS): string {
  const lines: string[] = []
  if (ledger.deadEnds.length > 0) {
    lines.push("Intentos que fallaron y no se repitieron con éxito (no los repitas igual):")
    for (const d of ledger.deadEnds) {
      lines.push(`- ${d.tool}${d.target ? ` ${d.target}` : ""}${d.error ? ` → ${d.error}` : ""}${d.times > 1 ? ` (${d.times} veces)` : ""}`)
    }
  }
  const changed = listFiles("Archivos modificados", ledger.changed)
  if (changed) lines.push(changed)
  if (ledger.checks.length > 0) {
    lines.push(
      "Comprobaciones, último resultado: " +
        ledger.checks.map((c) => `${c.tool} ${c.ok ? "✓" : `✗${c.error ? ` (${c.error})` : ""}`}`).join("; "),
    )
  }
  if (ledger.commands.length > 0) {
    lines.push("Últimos comandos: " + ledger.commands.map((c) => `\`${c.command}\` ${c.ok ? "✓" : `✗${c.error ? ` (${c.error})` : ""}`}`).join("; "))
  }
  const read = listFiles("Archivos leídos", ledger.read)
  if (read) lines.push(read)
  if (lines.length === 0) return ""

  let body = ""
  for (const line of lines) {
    if (body.length + line.length + 1 > maxChars) break
    body += `${line}\n`
  }
  if (!body) return ""
  return (
    "\n\n# LIBRO DE TRABAJO (derivado del registro de herramientas de este hilo)\n" +
    "Hechos de lo ya ejecutado, no resumen: úsalo para no repetir trabajo ni intentos fallidos.\n" +
    body
  )
}

/** Carga el libro de un hilo desde `toolRuns` (las llamadas más recientes, acotadas). */
export async function loadWorkLedger(threadId: string): Promise<WorkLedger> {
  const toolRuns = await col<ToolRunDoc>("toolRuns")
  const entries = await toolRuns.findBy("task_id", threadId, { limit: MAX_TOOL_RUNS })
  return buildWorkLedger(entries.map((e) => e.doc))
}
