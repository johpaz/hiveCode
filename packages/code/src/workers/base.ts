import { col } from "@johpaz/hivecode-core/storage/hive"
import type { FileRiskDoc } from "@johpaz/hivecode-core/storage/collections"
import type { Blackboard } from "../context/blackboard.ts"
import type { ConflictDetector } from "../context/conflict-detector.ts"
import type { IpcEmitter } from "../context/ipc-emitter.ts"

export abstract class BaseWorker {
  constructor(
    protected name: string,
    protected sessionId: string,
    protected db: unknown,
    protected blackboard: Blackboard,
    protected detector: ConflictDetector,
    protected ipc: IpcEmitter,
  ) {}

  /** Llamar antes de tocar cualquier archivo: detecta conflictos y registra riesgo. */
  protected async safeWrite(filePath: string, action: () => Promise<void>): Promise<void> {
    await this.blackboard.readRelevant(this.name, { filePath })

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

    await this.recordFileRisk(filePath, conflicts.some(c => c.severity === "high") ? "high" : "medium")
    await this.blackboard.write(this.name, "observation", `Iniciando escritura en ${filePath}`, { filePath })

    await action()

    await this.blackboard.write(this.name, "observation", `Completada escritura en ${filePath}`, { filePath })

    this.ipc.emit("file_risk_update", {
      path: filePath,
      risk: "low",
      operation: "modified",
      agent: this.name,
    })
  }

  /** Publicar razonamiento: va al blackboard y al TUI como ReasoningChunk. */
  protected async think(reasoning: string, filePath?: string): Promise<void> {
    await this.blackboard.write(this.name, "reasoning", reasoning, { filePath })
    this.ipc.emit("reasoning_chunk", {
      coordinator: this.name,
      content: reasoning,
      is_final: false,
    })
  }

  /** Publicar una decision al blackboard, visible para otros workers y Bee. */
  protected async decide(decision: string, filePath?: string): Promise<void> {
    await this.blackboard.write(this.name, "decision", decision, { filePath })
  }

  /** Registrar una observacion sin bloquear. */
  protected async observe(observation: string, filePath?: string): Promise<void> {
    await this.blackboard.write(this.name, "observation", observation, { filePath })
  }

  private async recordFileRisk(filePath: string, riskLevel: string): Promise<void> {
    const risks = await col<FileRiskDoc>("fileRisks")
    const id = `${this.sessionId}:${this.name}:${filePath}`
    const existing = await risks.get(id)
    await risks.put(
      id,
      {
        id,
        session_id: this.sessionId,
        file_path: filePath,
        risk_level: riskLevel,
        operation: "modified",
        adr_ref: null,
        reason: null,
        agent: this.name,
        updated_at: Date.now(),
      },
      { expectedVersion: existing?.version ?? 0 },
    )
  }
}
