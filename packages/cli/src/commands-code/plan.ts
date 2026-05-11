import {
  hiveIntro, hiveOutro, hiveModeBar,
  hivePhaseComplete, hiveSpinner, hiveNote,
  hiveText, isCancel,
} from "../ui/index.ts"
import { getExecutionMode, setExecutionMode } from "@johpaz/hive-code-core"
import { CoordinatorManager } from "@johpaz/hive-code-code/workers/coordinator-manager"
import { ensureCodeDatabase } from "./db-init"

export async function plan(description?: string): Promise<void> {
  ensureCodeDatabase()

  hiveIntro("hive-code · Plan Mode")
  hiveModeBar("plan")

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
    process.exit(1)
  } finally {
    await manager.stopAll()
    setExecutionMode(prevMode)
  }

  hiveNote("Plan completado", [
    "Revisa el plan generado antes de ejecutar.",
    "Usa 'hive-code run \"<desc>\"' para implementar.",
    "Usa 'hive-code run \"<desc>\" --approval' para modo interactivo.",
  ])

  hiveOutro("Plan generado — revisa antes de ejecutar")
}
