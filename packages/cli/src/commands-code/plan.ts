import {
  hiveIntro, hiveOutro, hiveModeBar,
  hivePhaseComplete, hiveSpinner, hiveNote,
  hiveText, isCancel,
} from "@johpaz/hivecode-ui"
import { getExecutionMode, setExecutionMode } from "@johpaz/hivecode-core"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { listenModeToggle, stopModeToggle } from "@johpaz/hivecode-code/modes/keyboard"

export async function plan(description?: string, options?: { keyboard?: boolean; exitOnError?: boolean }): Promise<void> {
  const exitOnError = options?.exitOnError ?? true

  hiveIntro("hivecode · Plan Mode")
  hiveModeBar("plan")

  if (options?.keyboard !== false) {
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
    hiveOutro("Cancelado", "error")
    process.exit(0)
  }

  const prevMode = getExecutionMode()
  setExecutionMode("plan")

  const manager = new CoordinatorManager()
  await manager.startAll()

  const spinner = hiveSpinner("architecture")
  spinner.start("Architecture Coordinator: analizando codebase...")

  try {
    await manager.runTask(task, "plan")
    spinner.stop("Arquitectura diseñada")
    hivePhaseComplete("architecture", "Architecture Coordinator completó el plan")
  } catch (err) {
    spinner.stop(`Error: ${(err as Error).message}`, "error")
    hiveOutro("Plan fallido", "error")
    if (exitOnError) process.exit(1)
    else throw err
  } finally {
    await manager.stopAll()
    setExecutionMode(prevMode)
    stopModeToggle()
  }

  hiveNote("Plan completado", [
    "Revisa el plan generado antes de ejecutar.",
    "Usa 'hivecode run \"<desc>\"' para implementar.",
    "Usa 'hivecode run \"<desc>\" --approval' para modo interactivo.",
  ])

  hiveOutro("Plan generado — revisa antes de ejecutar")
}
