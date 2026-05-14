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
  hiveNote, hiveSpinner, isCancel,
} from "@johpaz/hivecode-ui"
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
    })

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
  const task = db.query("SELECT id, description, status, mode FROM code_tasks WHERE id = ?").get(taskId) as any

  if (!task) {
    hiveOutro(`Tarea no encontrada: ${taskId}`, "error")
    process.exit(1)
  }

  if (task.status !== "paused") {
    hiveOutro(`La tarea ${taskId.slice(0, 8)} no está pausada (estado: ${task.status})`, "error")
    process.exit(1)
  }

  db.query("UPDATE code_tasks SET status = 'running' WHERE id = ?").run(taskId)

  hiveNote("Tarea reanudada", [
    `ID: ${taskId}`,
    `Descripción: ${task.description?.slice(0, 60)}`,
    `Modo: ${task.mode}`,
    "",
    "Usa 'hivecode run \"<desc>\"' para ejecutar una nueva tarea.",
  ])

  hiveOutro("Tarea reanudada")
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
