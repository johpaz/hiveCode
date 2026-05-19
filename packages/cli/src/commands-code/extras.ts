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
} from "@johpaz/hivecode-tui-primitives"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { executeToolByName } from "@johpaz/hivecode-code/workers/tool-bridge"
import { createAllTools } from "@johpaz/hivecode-core/tools"
import { loadConfig } from "@johpaz/hivecode-core/config"

// ─── Mode History ────────────────────────────────────────────────────────────

export async function modeHistory(): Promise<void> {
  hiveIntro("hivecode · Historial de Modos")

  const db = getDb()
  const rows = db.query(`
    SELECT sm.*, t.description
    FROM code_session_modes sm
    LEFT JOIN code_tasks t ON sm.task_id = t.id
    ORDER BY sm.changed_at DESC
    LIMIT 20
  `).all() as any[]

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

  const db = getDb()
  const task = db.query(
    "SELECT id, description, status, mode FROM code_tasks WHERE id = ? OR id LIKE ? LIMIT 1"
  ).get(taskId, `${taskId}%`) as any

  if (!task) {
    hiveOutro(`Tarea no encontrada: ${taskId}`, "error")
    process.exit(1)
  }

  if (task.status !== "paused") {
    hiveOutro(`La tarea ${task.id.slice(0, 8)} no está pausada (estado: ${task.status})`, "error")
    process.exit(1)
  }

  // ── Recovery point ────────────────────────────────────────────────────────
  const recovery = db.query(
    "SELECT * FROM code_recovery_points WHERE task_id = ? ORDER BY id DESC LIMIT 1"
  ).get(task.id) as any

  const snapshots = db.query(
    "SELECT file_path, content FROM code_file_snapshots WHERE task_id = ? ORDER BY id"
  ).all(task.id) as any[]

  let filesRestored = 0

  if (snapshots.length > 0) {
    const shouldRestore = await hiveConfirm({
      message: `Hay ${snapshots.length} snapshot(s) de archivos guardados. ¿Restaurar al estado anterior?`,
    })

    if (!isCancel(shouldRestore) && shouldRestore) {
      const spinner = hiveSpinner("default")
      spinner.start("Restaurando archivos...")
      for (const snap of snapshots) {
        try {
          await Bun.write(snap.file_path, snap.content)
          filesRestored++
        } catch {
          // file path may be outside cwd — skip silently
        }
      }
      spinner.stop(`${filesRestored} archivo(s) restaurado(s)`)
    }
  }

  // ── Update task status ────────────────────────────────────────────────────
  db.query("UPDATE code_tasks SET status = 'running' WHERE id = ?").run(task.id)

  // ── Summary ───────────────────────────────────────────────────────────────
  const lines: string[] = [
    `ID: ${task.id}`,
    `Descripción: ${task.description?.slice(0, 60)}`,
    `Modo: ${task.mode}`,
    "",
  ]

  if (recovery) {
    const completed: number[] = JSON.parse(recovery.completed_phases || "[]")
    const pending: number[] = JSON.parse(recovery.pending_phases || "[]")
    if (completed.length > 0) lines.push(`Fases completadas: ${completed.length}`)
    if (pending.length > 0) lines.push(`Fases pendientes: ${pending.length}`)
    if (recovery.git_ref) lines.push(`Git ref: ${(recovery.git_ref as string).slice(0, 8)}`)
  }

  if (filesRestored > 0) lines.push(`Archivos restaurados: ${filesRestored}`)
  lines.push("", "Usa 'hivecode run \"<desc>\"' para continuar con una nueva ejecución.")

  hiveNote("Tarea reanudada", lines)
  hiveOutro("Listo para reanudar")
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
  const db = getDb()
  const task = db.query<any, [string, string]>(
    "SELECT * FROM code_tasks WHERE id = ? OR id LIKE ? LIMIT 1"
  ).get(taskId, `${taskId}%`) as any

  if (!task) {
    hiveOutro(`Tarea no encontrada: ${taskId}`, "error")
    process.exit(1)
  }

  const phaseFilter = (() => {
    const idx = flags.indexOf("--phase")
    return idx !== -1 ? Number(flags[idx + 1]) : null
  })()

  hiveIntro(`hivecode · Debug · ${task.id.slice(0, 8)}`)

  const w = process.stdout.columns || 100

  // ── Task overview ──────────────────────────────────────────────────────────
  const statusColor = task.status === "completed" ? GREEN : task.status === "failed" ? RED : AMBER
  process.stdout.write(`\n${BOLD}TAREA${RESET}\n`)
  process.stdout.write(`  ID          ${CYAN}${task.id}${RESET}\n`)
  process.stdout.write(`  Descripción ${task.description}\n`)
  process.stdout.write(`  Estado      ${statusColor}${task.status}${RESET}   Modo: ${AMBER}${task.mode}${RESET}\n`)
  if (task.branch_name) process.stdout.write(`  Rama        ${DIM}${task.branch_name}${RESET}\n`)
  process.stdout.write(`  Duración    ${fmt(task.duration_ms || 0)}   Tokens: ${tokens(task.tokens_in || 0, task.tokens_out || 0)}\n`)
  process.stdout.write(`  Archivos    ${task.files_changed || 0} cambiados   +${task.lines_added || 0} / -${task.lines_removed || 0} líneas\n`)
  process.stdout.write(`  Creada      ${DIM}${task.created_at}${RESET}\n`)

  // ── Phase breakdown ────────────────────────────────────────────────────────
  const phases = db.query<any, [string]>(
    "SELECT * FROM code_task_phases WHERE task_id = ? ORDER BY id ASC"
  ).all(task.id) as any[]

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
    const traces = db.query<any, [string, string]>(
      "SELECT * FROM code_traces WHERE task_id = ? AND coordinator = ? ORDER BY id ASC"
    ).all(task.id, p.coordinator) as any[]

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
    const narrativeEntries = db.query<any, [string, string]>(
      "SELECT entry, is_override FROM code_narrative WHERE task_id = ? AND coordinator = ? ORDER BY id ASC"
    ).all(task.id, p.coordinator) as any[]

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
    const placeholders = coordinatorNames.map(() => "?").join(",")
    const rules = db.query<any, string[]>(
      `SELECT rule, coordinator, confidence FROM code_playbook
       WHERE active = 1 AND (coordinator IN (${placeholders}) OR coordinator IS NULL)
       ORDER BY confidence DESC LIMIT 10`
    ).all(...coordinatorNames) as any[]

    if (rules.length > 0) {
      process.stdout.write(`\n${BOLD}PLAYBOOK ACTIVO${RESET}  (${rules.length} reglas)\n`)
      for (const r of rules) {
        const conf = `${Math.round(r.confidence * 100)}%`
        process.stdout.write(`  ${GREEN}●${RESET} ${DIM}[${conf}]${RESET} ${r.rule}\n`)
      }
    }
  }

  // ── File changes ──────────────────────────────────────────────────────────
  const fileChanges = db.query<any, [string]>(
    "SELECT file_path, change_type, lines_added, lines_removed FROM code_file_changes WHERE task_id = ? ORDER BY id ASC"
  ).all(task.id) as any[]

  if (fileChanges.length > 0) {
    process.stdout.write(`\n${BOLD}ARCHIVOS MODIFICADOS${RESET}  (${fileChanges.length})\n`)
    for (const f of fileChanges) {
      const typeIcon = f.change_type === "added" ? `${GREEN}A${RESET}` : f.change_type === "deleted" ? `${RED}D${RESET}` : `${AMBER}M${RESET}`
      process.stdout.write(`  ${typeIcon} ${f.file_path}  ${DIM}+${f.lines_added} -${f.lines_removed}${RESET}\n`)
    }
  }

  // ── PR / branch ───────────────────────────────────────────────────────────
  if (task.pr_url) {
    process.stdout.write(`\n${BOLD}PULL REQUEST${RESET}\n  ${CYAN}${task.pr_url}${RESET}\n`)
  }

  process.stdout.write("\n")
  hiveOutro(phaseFilter !== null ? `Fase ${phaseFilter} de ${phases.length}` : `${phases.length} fases · ${fmt(task.duration_ms || 0)}`)
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
