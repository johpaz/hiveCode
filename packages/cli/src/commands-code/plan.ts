import {
  hiveIntro, hiveOutro, hiveModeBar,
  hivePhaseComplete, hiveSpinner, hiveNote,
  hiveText, isCancel,
} from "../cli-ui.ts"
import { getExecutionMode, setExecutionMode } from "@johpaz/hivecode-core"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { listenModeToggle, stopModeToggle } from "@johpaz/hivecode-code/modes/keyboard"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

const CYAN   = "\x1b[38;5;87m"
const AMBER  = "\x1b[38;5;214m"
const GREEN  = "\x1b[38;5;114m"
const BOLD   = "\x1b[1m"
const DIM    = "\x1b[2m"
const RESET  = "\x1b[0m"

function renderHarness(harness: string): void {
  process.stdout.write("\n")
  for (const line of harness.split("\n")) {
    if (line.startsWith("ARNÉS")) {
      process.stdout.write(`${BOLD}${CYAN}${line}${RESET}\n`)
    } else if (/^(RECONOCIMIENTO|HIPÓTESIS|DECISIONES|CONTRATOS|SUBAGENTES|ARCHIVOS|RIESGOS|ESTIMADO)/.test(line)) {
      process.stdout.write(`\n${BOLD}${AMBER}${line}${RESET}\n`)
    } else if (/^\s+HIGH:/.test(line)) {
      process.stdout.write(`\x1b[38;5;203m${line}${RESET}\n`)
    } else if (/^\s+MEDIUM:/.test(line)) {
      process.stdout.write(`${AMBER}${line}${RESET}\n`)
    } else if (/^\s+LOW:/.test(line)) {
      process.stdout.write(`${DIM}${line}${RESET}\n`)
    } else if (/^\s+\+/.test(line)) {
      process.stdout.write(`${GREEN}${line}${RESET}\n`)
    } else if (/^\s+~/.test(line)) {
      process.stdout.write(`${AMBER}${line}${RESET}\n`)
    } else {
      process.stdout.write(`${line}\n`)
    }
  }
  process.stdout.write("\n")
}

export async function plan(
  description?: string,
  options?: { keyboard?: boolean; exitOnError?: boolean; manager?: CoordinatorManager; quiet?: boolean }
): Promise<void> {
  const exitOnError = options?.exitOnError ?? true
  const externalManager = !!options?.manager
  const quiet = options?.quiet ?? false

  if (!quiet) {
    hiveIntro("hivecode · Plan Mode")
    hiveModeBar("plan")
  }

  if (!quiet && options?.keyboard !== false) {
    listenModeToggle((mode) => {
      hiveModeBar(mode)
    })
  }

  const task = description ?? await hiveText({
    message: "¿Qué quieres diseñar?",
    placeholder: "implementa autenticación JWT...",
    validate: (v) => v.length < 10 ? "Describe la tarea con más detalle" : undefined,
  })

  if (isCancel(task) || !task || typeof task !== "string") {
    if (!quiet) hiveOutro("Cancelado", "error")
    process.exit(0)
  }

  const prevMode = getExecutionMode()
  setExecutionMode("plan")

  const manager = options?.manager ?? new CoordinatorManager()
  if (!externalManager) await manager.startAll()

  const spinner = quiet ? null : hiveSpinner("architecture")
  spinner?.start("BEE: analizando tarea...")

  let activeTaskId: string | null = null

  try {
    await manager.runTask(task, "plan")
    activeTaskId = (manager as any).activeTaskId ?? null
    spinner?.stop("Arquitectura diseñada")
    if (!quiet) hivePhaseComplete("architecture", "Architecture Coordinator completó el plan")
  } catch (err) {
    spinner?.stop(`Error: ${(err as Error).message}`, "error")
    if (!quiet) hiveOutro("Plan fallido", "error")
    if (exitOnError) process.exit(1)
    else throw err
  } finally {
    if (!externalManager) await manager.stopAll()
    setExecutionMode(prevMode)
    if (!quiet) stopModeToggle()
  }

  // Show the harness if Bee generated one
  if (!quiet && activeTaskId) {
    try {
      const db = getDb()
      const row = db.query(
        "SELECT entry FROM code_narrative WHERE task_id = ? AND phase = 'harness' ORDER BY id DESC LIMIT 1"
      ).get(activeTaskId) as any
      if (row?.entry) renderHarness(row.entry)
    } catch { /* DB may not be available in some test contexts */ }
  }

  if (!quiet) {
    hiveNote("Plan completado", [
      "Revisa el arnés generado antes de ejecutar.",
      "Usa 'hivecode run \"<desc>\"' para implementar.",
      "Usa 'hivecode run \"<desc>\" --approval' para modo interactivo.",
    ])

    hiveOutro("Plan generado — revisa antes de ejecutar")
  }
}
