/**
 * Additional commands for Hive-Code CLI.
 *
 * mode history
 * task rollback <id>
 * task resume <id>
 * upgrade
 * init [path]
 */

import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveSpinner, hiveConfirm, isCancel,
} from "../cli-ui.ts"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type {
  CodeFileChangeDoc,
  CodeNarrativeDoc,
  CodePlaybookDoc,
  CodeRecoveryPointDoc,
  CodeSessionModeDoc,
  CodeTaskDoc,
  CodeTaskPhaseDoc,
  CodeTaskPlanDoc,
  CodeTraceDoc,
  HarnessTaskDoc,
} from "@johpaz/hivecode-core/storage/collections"
import { executeToolByName } from "@johpaz/hivecode-code/workers/tool-bridge"
import { createAllTools } from "@johpaz/hivecode-core/tools"
import { loadConfig } from "@johpaz/hivecode-core/config"

function nowIso(): string {
  return new Date().toISOString()
}

async function findTask(taskId: string): Promise<{ id: string; doc: CodeTaskDoc; version: number } | null> {
  const tasks = await col<CodeTaskDoc>("codeTasks")
  const exact = await tasks.get(taskId)
  if (exact) return { id: taskId, doc: exact.doc, version: exact.version }
  const rows = await tasks.scan()
  const match = rows.find((entry) => entry.id === taskId || entry.id.startsWith(taskId))
  return match ? { id: match.id, doc: match.doc, version: match.version } : null
}

// ─── Mode History ────────────────────────────────────────────────────────────

export async function modeHistory(): Promise<void> {
  hiveIntro("hivecode · Historial de Modos")

  const tasks = new Map(
    (await (await col<CodeTaskDoc>("codeTasks")).scan()).map((entry) => [entry.id, entry.doc])
  )
  const rows = (await (await col<CodeSessionModeDoc>("codeSessionModes")).scan())
    .map((entry) => ({
      ...entry.doc,
      description: entry.doc.task_id ? tasks.get(entry.doc.task_id)?.description : undefined,
    }))
    .sort((a, b) => b.changed_at.localeCompare(a.changed_at))
    .slice(0, 20)

  if (rows.length === 0) {
    hiveNote("Sin historial", ["No hay cambios de modo registrados."])
    hiveOutro("Sin historial")
    return
  }

  for (const row of rows) {
    const modeColor = row.mode === "plan" ? "\x1b[38;5;141m" : row.mode === "approval" ? "\x1b[38;5;214m" : "\x1b[38;5;114m"
    const date = new Date(row.changed_at).toLocaleString("es-CO", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })
    hivePhaseComplete("principal", `[${date}] ${modeColor}${row.mode.toUpperCase()}\x1b[0m`)
    if (row.description) {
      process.stdout.write(`  │    Tarea: ${row.description.slice(0, 50)}\n`)
    }
    if (row.phase_at_change) {
      process.stdout.write(`  │    Fase: ${row.phase_at_change}\n`)
    }
    process.stdout.write(`  │\n`)
  }

  hiveOutro(`${rows.length} cambio(s) de modo`)
}

// ─── Task Rollback ───────────────────────────────────────────────────────────

export async function taskRollback(taskId?: string): Promise<void> {

  if (!taskId) {
    hiveOutro("Uso: hivecode task rollback <id>", "error")
    process.exit(1)
  }

  hiveIntro("hivecode · Rollback")

  const spinner = hiveSpinner("default")
  spinner.start(`Revirtiendo tarea ${taskId.slice(0, 8)}...`)

  try {
    const config = await loadConfig()
    const allTools = createAllTools(config)
    const result = await executeToolByName(allTools, "git_rollback", {
      taskId,
      path: process.cwd(),
      dryRun: false,
      confirmed: true,
    }, { configurable: { workspace: process.cwd() } })

    if ((result as any)?.ok) {
      spinner.stop(`Tarea ${taskId.slice(0, 8)} revertida`)
      const info = (result as any).result
      hiveNote("Rollback completado", [
        `Archivos restaurados: ${info?.filesRestored || "N/A"}`,
        `Rama eliminada: ${info?.branchDeleted ? "Sí" : "No"}`,
      ])
      hiveOutro("Rollback exitoso")
    } else {
      spinner.stop(`Error: ${(result as any)?.error || "unknown"}`, "error")
      hiveOutro("Rollback fallido", "error")
      process.exit(1)
    }
  } catch (err) {
    spinner.stop(`Error: ${(err as Error).message}`, "error")
    hiveOutro("Rollback fallido", "error")
    process.exit(1)
  }
}

// ─── Task Resume ─────────────────────────────────────────────────────────────

export async function taskResume(taskId?: string): Promise<void> {

  if (!taskId) {
    hiveOutro("Uso: hivecode task resume <id>", "error")
    process.exit(1)
  }

  hiveIntro("hivecode · Reanudar Tarea")

  const task = await findTask(taskId)

  if (!task) {
    hiveOutro(`Tarea no encontrada: ${taskId}`, "error")
    process.exit(1)
  }

  const resumable = task.doc.status === "paused" || task.doc.status === "failed"
  if (!resumable) {
    hiveOutro(`La tarea ${task.doc.id.slice(0, 8)} no es reanudable (estado: ${task.doc.status})`, "error")
    process.exit(1)
  }

  // ── Recovery point + persisted plan ───────────────────────────────────────
  const recovery = (await (await col<CodeRecoveryPointDoc>("codeRecoveryPoints")).findBy("task_id", task.doc.id))
    .map((entry) => entry.doc)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]

  const plan = await (await col<CodeTaskPlanDoc>("codeTaskPlans")).get(task.doc.id)
  const profileTask = (await (await col<HarnessTaskDoc>("harnessTasks")).scan())
    .map(entry => entry.doc)
    .filter(entry => entry.parentTaskId === task.doc.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]

  if (!plan && !profileTask) {
    // Task predates plan persistence — we can't re-enter the phase loop, so fall
    // back to the old behaviour: mark running and tell the user to re-run.
    await (await col<CodeTaskDoc>("codeTasks")).put(task.id, { ...task.doc, status: "running" }, { expectedVersion: task.version })
    hiveNote("Sin plan persistido", [
      `ID: ${task.doc.id}`,
      "Esta tarea es anterior a la persistencia de planes y no puede reanudarse automáticamente.",
      "",
      "Usa 'hivecode run \"<desc>\"' para continuar con una nueva ejecución.",
    ])
    hiveOutro("Listo para reanudar manualmente")
    return
  }

  const startLevel = recovery?.level ?? 0
  const shouldResume = await hiveConfirm({
    message: profileTask
      ? `Reanudar la tarea desde ${profileTask.stage}? Se conservarán los nodos completados del DAG.`
      : `Reanudar la tarea desde el nivel ${startLevel}? Se relanzan los coordinadores para continuar el trabajo.`,
  })
  if (isCancel(shouldResume) || !shouldResume) {
    hiveOutro("Reanudación cancelada")
    return
  }

  // ── Re-enter the phase loop at the recovery point ─────────────────────────
  const spinner = hiveSpinner("default")
  spinner.start(`Reanudando tarea en el nivel ${startLevel}...`)
  const { CoordinatorManager } = await import("@johpaz/hivecode-code/workers/coordinator-manager")
  const manager = new CoordinatorManager()
  let completed = false
  try {
    await manager.startAll()
    completed = await manager.resumeTask(task.doc.id)
  } catch (err) {
    spinner.stop("Reanudación falló")
    hiveOutro(`Error al reanudar: ${(err as Error).message}`, "error")
    await manager.stopAll()
    process.exit(1)
  }
  await manager.stopAll()
  spinner.stop(completed ? "Tarea reanudada y completada" : "Reanudación finalizada (revisa el estado)")

  const lines: string[] = [
    `ID: ${task.doc.id}`,
    `Descripción: ${task.doc.description?.slice(0, 60)}`,
    `Nivel de reanudación: ${startLevel}`,
    `Resultado: ${completed ? "completada" : "no completada — revisa hivecode task status"}`,
  ]
  if (recovery?.git_ref) lines.push(`Git ref: ${(recovery.git_ref as string).slice(0, 8)}`)

  hiveNote("Tarea reanudada", lines)
  hiveOutro(completed ? "Tarea completada" : "Reanudación finalizada")
}

// ─── Upgrade ─────────────────────────────────────────────────────────────────

export async function upgrade(): Promise<void> {
  hiveIntro("hivecode · Actualizar")

  const spinner = hiveSpinner("default")
  spinner.start("Verificando última versión...")

  try {
    const response = await fetch("https://api.github.com/repos/johpaz/hivecode/releases/latest")
    const data = await response.json()
    const latestVersion = data.tag_name as string
    const currentVersion = "v0.1.0"

    if (latestVersion === currentVersion) {
      spinner.stop("Ya tienes la última versión")
      hiveOutro(`${currentVersion} — sin actualizaciones`)
      return
    }

    spinner.stop(`Nueva versión disponible: ${latestVersion}`)
    hiveNote("Instrucciones de actualización", [
      `Versión actual: ${currentVersion}`,
      `Última versión: ${latestVersion}`,
      "",
      "Para actualizar:",
      "  bun install -g @johpaz/hivecode@latest",
      "  o descarga el binario desde GitHub Releases",
    ])
    hiveOutro("Revisa las instrucciones arriba")
  } catch (err) {
    spinner.stop("No se pudo verificar actualizaciones", "error")
    hiveOutro("Verifica tu conexión a internet", "error")
  }
}

// ─── Task Debug ──────────────────────────────────────────────────────────────

const DIM  = "\x1b[2m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"
const CYAN  = "\x1b[38;5;87m"
const AMBER = "\x1b[38;5;214m"
const GREEN = "\x1b[38;5;114m"
const RED   = "\x1b[38;5;203m"
const PURPLE = "\x1b[38;5;141m"

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function tokens(i: number, o: number): string {
  const total = i + o
  const usd = ((total / 1_000_000) * 3).toFixed(4)
  return `${total.toLocaleString()} tokens (~$${usd})`
}

export async function taskDebug(taskId?: string, flags: string[] = []): Promise<void> {
  if (!taskId) {
    hiveOutro("Uso: hivecode task debug <id> [--phase N]", "error")
    process.exit(1)
  }

  // Support short IDs (first 8 chars)
  const task = await findTask(taskId)

  if (!task) {
    hiveOutro(`Tarea no encontrada: ${taskId}`, "error")
    process.exit(1)
  }

  const phaseFilter = (() => {
    const idx = flags.indexOf("--phase")
    return idx !== -1 ? Number(flags[idx + 1]) : null
  })()

  hiveIntro(`hivecode · Debug · ${task.doc.id.slice(0, 8)}`)

  const w = process.stdout.columns || 100

  // ── Task overview ──────────────────────────────────────────────────────────
  const statusColor = task.doc.status === "completed" ? GREEN : task.doc.status === "failed" ? RED : AMBER
  process.stdout.write(`\n${BOLD}TAREA${RESET}\n`)
  process.stdout.write(`  ID          ${CYAN}${task.doc.id}${RESET}\n`)
  process.stdout.write(`  Descripción ${task.doc.description}\n`)
  process.stdout.write(`  Estado      ${statusColor}${task.doc.status}${RESET}   Modo: ${AMBER}${task.doc.mode}${RESET}\n`)
  if (task.doc.branch_name) process.stdout.write(`  Rama        ${DIM}${task.doc.branch_name}${RESET}\n`)
  process.stdout.write(`  Duración    ${fmt(task.doc.duration_ms || 0)}   Tokens: ${tokens(task.doc.tokens_in || 0, task.doc.tokens_out || 0)}\n`)
  process.stdout.write(`  Archivos    ${task.doc.files_changed || 0} cambiados   +${task.doc.lines_added || 0} / -${task.doc.lines_removed || 0} líneas\n`)
  process.stdout.write(`  Creada      ${DIM}${task.doc.created_at}${RESET}\n`)

  // ── Phase breakdown ────────────────────────────────────────────────────────
  const phases = (await (await col<CodeTaskPhaseDoc>("codeTaskPhases")).findBy("task_id", task.doc.id))
    .map((entry) => entry.doc)
    .sort((a, b) => a.id.localeCompare(b.id))

  process.stdout.write(`\n${BOLD}FASES${RESET}  (${phases.length} total)\n`)

  const phasesToShow = phaseFilter !== null
    ? phases.filter((_, i) => i + 1 === phaseFilter)
    : phases

  if (phasesToShow.length === 0) {
    process.stdout.write(`  ${DIM}Sin fases para --phase ${phaseFilter}${RESET}\n`)
  }

  for (let i = 0; i < phasesToShow.length; i++) {
    const p = phasesToShow[i]
    const phaseIdx = phases.indexOf(p) + 1
    const sc = p.status === "completed" ? GREEN : p.status === "failed" ? RED : p.status === "skipped" ? DIM : AMBER
    process.stdout.write(`\n  ${BOLD}${phaseIdx}. ${p.coordinator}${RESET}  ${sc}${p.status}${RESET}\n`)
    process.stdout.write(`     Duración: ${fmt(p.duration_ms || 0)}   Tokens: ${tokens(p.tokens_in || 0, p.tokens_out || 0)}\n`)
    if (p.started_at) process.stdout.write(`     Inicio: ${DIM}${p.started_at}${RESET}\n`)

    if (p.result_summary) {
      const preview = p.result_summary.length > 200
        ? p.result_summary.slice(0, 200) + "…"
        : p.result_summary
      process.stdout.write(`     Resumen: ${preview}\n`)
    }

    // Tool traces for this phase
    const traces = (await (await col<CodeTraceDoc>("codeTraces")).findBy("task_id", task.doc.id))
      .map((entry) => entry.doc)
      .filter((trace) => trace.coordinator === p.coordinator)
      .sort((a, b) => a.id.localeCompare(b.id))

    if (traces.length > 0) {
      process.stdout.write(`\n     ${DIM}── Herramientas (${traces.length}) ──${RESET}\n`)
      for (const t of traces) {
        const icon = t.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
        const durationMs = t.duration_ns ? Math.round(Number(t.duration_ns) / 1_000_000) : 0
        process.stdout.write(`     ${icon} ${CYAN}${t.tool_name}${RESET}  ${DIM}${fmt(durationMs)}${RESET}\n`)
        if (t.input_summary) {
          process.stdout.write(`       ← ${DIM}${t.input_summary.slice(0, 120)}${RESET}\n`)
        }
        if (t.output_summary) {
          const out = t.output_summary.slice(0, 120)
          const outColor = t.success ? DIM : RED
          process.stdout.write(`       → ${outColor}${out}${RESET}\n`)
        }
      }
    }

    // Narrative for this phase
    const narrativeEntries = (await (await col<CodeNarrativeDoc>("codeNarrative")).findBy("task_id", task.doc.id))
      .map((entry) => entry.doc)
      .filter((entry) => entry.coordinator === p.coordinator)
      .sort((a, b) => a.id.localeCompare(b.id))

    if (narrativeEntries.length > 0) {
      process.stdout.write(`\n     ${DIM}── Narrativo ──${RESET}\n`)
      for (const n of narrativeEntries) {
        const overrideTag = n.is_override ? ` ${AMBER}[OVERRIDE]${RESET}` : ""
        const text = (n.entry as string).slice(0, 300).replace(/\n/g, "\n     ")
        process.stdout.write(`     ${text}${overrideTag}\n`)
      }
    }
  }

  // ── Playbook rules active for this task's coordinators ────────────────────
  const coordinatorNames = [...new Set(phases.map(p => p.coordinator))]
  if (coordinatorNames.length > 0) {
    const rules = (await (await col<CodePlaybookDoc>("codePlaybook")).findBy("active", true))
      .map((entry) => entry.doc)
      .filter((rule) => rule.coordinator == null || coordinatorNames.includes(rule.coordinator as any))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10)

    if (rules.length > 0) {
      process.stdout.write(`\n${BOLD}PLAYBOOK ACTIVO${RESET}  (${rules.length} reglas)\n`)
      for (const r of rules) {
        const conf = `${Math.round(r.confidence * 100)}%`
        process.stdout.write(`  ${GREEN}●${RESET} ${DIM}[${conf}]${RESET} ${r.rule}\n`)
      }
    }
  }

  // ── File changes ──────────────────────────────────────────────────────────
  const fileChanges = (await (await col<CodeFileChangeDoc>("codeFileChanges")).findBy("task_id", task.doc.id))
    .map((entry) => entry.doc)
    .sort((a, b) => a.id.localeCompare(b.id))

  if (fileChanges.length > 0) {
    process.stdout.write(`\n${BOLD}ARCHIVOS MODIFICADOS${RESET}  (${fileChanges.length})\n`)
    for (const f of fileChanges) {
      const typeIcon = f.change_type === "added" ? `${GREEN}A${RESET}` : f.change_type === "deleted" ? `${RED}D${RESET}` : `${AMBER}M${RESET}`
      process.stdout.write(`  ${typeIcon} ${f.file_path}  ${DIM}+${f.lines_added} -${f.lines_removed}${RESET}\n`)
    }
  }

  // ── PR / branch ───────────────────────────────────────────────────────────
  if (task.doc.pr_url) {
    process.stdout.write(`\n${BOLD}PULL REQUEST${RESET}\n  ${CYAN}${task.doc.pr_url}${RESET}\n`)
  }

  process.stdout.write("\n")
  hiveOutro(phaseFilter !== null ? `Fase ${phaseFilter} de ${phases.length}` : `${phases.length} fases · ${fmt(task.doc.duration_ms || 0)}`)
}

// ─── Init ────────────────────────────────────────────────────────────────────

export async function init(pathArg?: string): Promise<void> {
  const targetPath = pathArg || process.cwd()

  hiveIntro("hivecode · Init")

  const spinner = hiveSpinner("default")
  spinner.start(`Inicializando ${targetPath}...`)

  try {
    // Create .hivecode directory
    await Bun.write(`${targetPath}/.hivecode/.gitkeep`, "")

    // Create default hivecode.yaml if not exists
    const configPath = `${targetPath}/hivecode.yaml`
    const configExists = await Bun.file(configPath).exists()

    if (!configExists) {
      await Bun.write(configPath, `# Hive-Code Configuration
project:
  name: ${targetPath.split("/").pop() || "project"}
  language: typescript
  runtime: bun

coordinators:
  architecture: true
  backend: true
  frontend: true
  security: true
  test: true
  devops: true

modes:
  default: approval

# See docs: https://hivecode.io/docs
`)
    }

    spinner.stop(`Proyecto inicializado en ${targetPath}`)
    hiveNote("Siguientes pasos", [
      "1. Configura tus API keys: hivecode secret set <name>",
      "2. Configura providers: hivecode provider add <name>",
      "3. Empieza a codear: hivecode run \"implementa...\"",
    ])
    hiveOutro("Proyecto listo")
  } catch (err) {
    spinner.stop(`Error: ${(err as Error).message}`, "error")
    hiveOutro("Init fallido", "error")
    process.exit(1)
  }
}
