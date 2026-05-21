import { FileRisksRepo } from "@johpaz/hivecode-core/db"
import type { Database } from "bun:sqlite"
import type { Blackboard } from "../context/blackboard.ts"
import type { ConflictDetector } from "../context/conflict-detector.ts"
import type { IpcEmitter } from "../context/ipc-emitter.ts"

export abstract class BaseWorker {
  protected fileRisks: FileRisksRepo

  constructor(
    protected name: string,
    protected sessionId: string,
    protected db: Database,
    protected blackboard: Blackboard,
    protected detector: ConflictDetector,
    protected ipc: IpcEmitter,
  ) {
    this.fileRisks = new FileRisksRepo(db)
  }

  /** Llamar antes de tocar cualquier archivo — detecta conflictos y registra riesgo */
  protected async safeWrite(filePath: string, action: () => Promise<void>): Promise<void> {
    // 1. Leer contexto relevante del blackboard
    const context = this.blackboard.readRelevant(this.name, { filePath })

    // 2. Detectar conflictos — bloquear si hay críticos
    const conflicts = await this.detector.checkBeforeWrite(this.name, filePath)
    const hasCritical = conflicts.some(c => c.severity === "critical")
    if (hasCritical) {
      await this.blackboard.write(
        this.name,
        "observation",
        `Bloqueado en ${filePath}: ${conflicts[0].description}`,
        { filePath },
      )
      return
    }

    // 3. Registrar que voy a tocar este archivo
    this.fileRisks.upsert({
      session_id: this.sessionId,
      file_path: filePath,
      risk_level: conflicts.some(c => c.severity === "high") ? "high" : "medium",
      operation: "modified",
      adr_ref: null,
      reason: null,
      agent: this.name,
    })

    await this.blackboard.write(this.name, "observation", `Iniciando escritura en ${filePath}`, { filePath })

    // 4. Ejecutar acción
    await action()

    // 5. Confirmar finalización
    await this.blackboard.write(this.name, "observation", `Completada escritura en ${filePath}`, { filePath })

    this.ipc.emit("file_risk_update", {
      path: filePath,
      risk: "low",
      operation: "modified",
      agent: this.name,
    })
  }

  /** Publicar razonamiento — va al blackboard y al TUI como ReasoningChunk */
  protected async think(reasoning: string, filePath?: string): Promise<void> {
    await this.blackboard.write(this.name, "reasoning", reasoning, { filePath })
    this.ipc.emit("reasoning_chunk", {
      coordinator: this.name,
      content: reasoning,
      is_final: false,
    })
  }

  /** Publicar una decisión al blackboard (visible para otros workers y Bee) */
  protected async decide(decision: string, filePath?: string): Promise<void> {
    await this.blackboard.write(this.name, "decision", decision, { filePath })
  }

  /** Registrar una observación sin bloquear */
  protected async observe(observation: string, filePath?: string): Promise<void> {
    await this.blackboard.write(this.name, "observation", observation, { filePath })
  }
}
