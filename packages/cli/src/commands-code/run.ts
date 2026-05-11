import {
  hiveIntro, hiveOutro, hiveModeBar,
  hivePhaseComplete, hivePhaseActive, hiveSpinner,
  hiveNote, hiveText, hiveCheckpoint, isCancel,
} from "../ui/index.ts"
import { getExecutionMode, setExecutionMode } from "@johpaz/hive-code-core"
import { CoordinatorManager } from "@johpaz/hive-code-code/workers/coordinator-manager"

export async function run(description?: string, flags: string[] = []): Promise<void> {
  const approvalFlag = flags.includes("--approval") || flags.includes("-a")
  const mode = approvalFlag ? "approval" : "auto"

  hiveIntro(`hive-code · ${mode === "approval" ? "Approval" : "Auto"} Mode`)
  hiveModeBar(mode)

  const task = description ?? await hiveText({
    message: "¿Qué quieres construir?",
    placeholder: "implementa autenticación JWT...",
    validate: (v) => v.length < 10 ? "Describe la tarea con más detalle" : undefined,
  })

  if (isCancel(task) || !task || typeof task !== "string") {
    hiveOutro("Cancelado", "error")
    process.exit(0)
  }

  const prevMode = getExecutionMode()
  setExecutionMode(mode)

  const manager = new CoordinatorManager()
  await manager.startAll()

  // Track phases for approval mode
  const phaseResults: Array<{ coordinator: string; summary: string; filesCreated: string[]; filesModified: string[] }> = []
  let currentPhaseIndex = 0

  try {
    await manager.runTask(
      task,
      mode,
      mode === "approval"
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
                // Append instructions to narrative as USER OVERRIDE
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
    hiveOutro(`Tarea completada${taskId ? ` · ID: ${taskId.slice(0, 8)}` : ""}`)
  } catch (err) {
    hiveOutro(`Error: ${(err as Error).message}`, "error")
    process.exit(1)
  } finally {
    await manager.stopAll()
    setExecutionMode(prevMode)
  }
}
