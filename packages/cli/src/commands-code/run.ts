import {
  hiveIntro, hiveOutro, hiveModeBar,
  hivePhaseComplete, hivePhaseActive, hiveSpinner,
  hiveNote, hiveText, hiveCheckpoint, isCancel,
} from "@johpaz/hivecode-tui-primitives"
import { getExecutionMode, setExecutionMode } from "@johpaz/hivecode-core"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { listenModeToggle, stopModeToggle } from "@johpaz/hivecode-code/modes/keyboard"

export async function run(description?: string, flags: string[] = [], options?: { keyboard?: boolean; exitOnError?: boolean; manager?: CoordinatorManager; quiet?: boolean }): Promise<void> {
  const exitOnError = options?.exitOnError ?? true
  const externalManager = !!options?.manager
  const quiet = options?.quiet ?? false

  const approvalFlag = flags.includes("--approval") || flags.includes("-a")
  const mode = approvalFlag ? "approval" : "auto"

  if (!quiet) {
    hiveIntro(`hivecode · ${mode === "approval" ? "Approval" : "Auto"} Mode`)
    hiveModeBar(mode)
  }

  if (!quiet && options?.keyboard !== false) {
    listenModeToggle((newMode) => {
      hiveModeBar(newMode)
    })
  }

  const task = description ?? await hiveText({
    message: "¿Qué quieres construir?",
    placeholder: "implementa autenticación JWT...",
    validate: (v) => v.length < 10 ? "Describe la tarea con más detalle" : undefined,
  })

  if (isCancel(task) || !task || typeof task !== "string") {
    if (!quiet) hiveOutro("Cancelado", "error")
    process.exit(0)
  }

  const prevMode = getExecutionMode()
  setExecutionMode(mode)

  const manager = options?.manager ?? new CoordinatorManager()
  if (!externalManager) await manager.startAll()

  // Track phases for approval mode
  const phaseResults: Array<{ coordinator: string; summary: string; filesCreated: string[]; filesModified: string[] }> = []
  let currentPhaseIndex = 0

  try {
    await manager.runTask(
      task,
      mode,
      mode === "approval" && !quiet
        ? async (ctx) => {
            currentPhaseIndex = ctx.phaseIndex

            // Build completed info from previous phases
            const prevPhase = phaseResults[ctx.phaseIndex - 1]
            const completed = prevPhase
              ? {
                  filesCreated: prevPhase.filesCreated,
                  filesModified: prevPhase.filesModified,
                  summary: prevPhase.summary,
                }
              : undefined

            // Mock upcoming info (in real implementation, this would come from the coordinator)
            const upcoming = {
              coordinator: ctx.nextPhase ?? "devops",
              willCreate: [
                { path: `src/${ctx.nextPhase}/index.ts`, reason: `Implementar ${ctx.nextPhase}` },
              ],
              willModify: [],
            }

            const decision = await hiveCheckpoint({
              coordinator: ctx.phase,
              phaseNumber: ctx.phaseIndex + 1,
              totalPhases: ctx.totalPhases,
              completed,
              upcoming,
            })

            if (decision === "edit") {
              const instructions = await hiveText({
                message: "Instrucciones adicionales:",
                placeholder: "cambia el enfoque a...",
              })
              if (!isCancel(instructions) && typeof instructions === "string") {
                manager.recordUserOverride(instructions)
                hiveNote("Override registrado", [instructions])
              }
              return "approve" // Continue after edit
            }

            return decision
          }
        : undefined
    )

    // Success outro
    const taskId = manager.getActiveTaskId()
    if (!quiet) hiveOutro(`Tarea completada${taskId ? ` · ID: ${taskId.slice(0, 8)}` : ""}`)
  } catch (err) {
    if (!quiet) hiveOutro(`Error: ${(err as Error).message}`, "error")
    if (exitOnError) process.exit(1)
    else throw err
  } finally {
    if (!externalManager) await manager.stopAll()
    setExecutionMode(prevMode)
    if (!quiet) stopModeToggle()
  }
}
