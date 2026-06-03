import { randomBytes } from "node:crypto"
import type { Database } from "bun:sqlite"
import { CheckpointsRepo } from "@johpaz/hivecode-core/db/repos/checkpoints"
import type { IpcEmitter } from "../context/ipc-emitter.ts"
import { snapshotFiles } from "./snapshot.ts"
import { restoreFiles } from "./rollback.ts"

export class CheckpointManager {
  private repo: CheckpointsRepo

  constructor(
    private db: Database,
    private sessionId: string,
    private ipc: IpcEmitter,
  ) {
    this.repo = new CheckpointsRepo(db)
  }

  /**
   * Crea un checkpoint antes de que los workers escriban archivos.
   *
   * @param description  Descripción legible del punto de restauración
   * @param filePaths    Archivos existentes que serán modificados
   * @param filesToCreate Rutas que el agente va a crear (aún no existen)
   * @param createdBy    Quién crea el checkpoint: bee|backend|human|halt|…
   */
  async create(
    description: string,
    filePaths: string[],
    filesToCreate: string[] = [],
    createdBy: string = "bee",
  ): Promise<string> {
    const id = `cp_${Date.now()}_${randomBytes(2).toString("hex")}`
    const entries = await snapshotFiles(filePaths, filesToCreate, this.repo)

    this.repo.createCheckpoint({
      id,
      session_id: this.sessionId,
      created_by: createdBy,
      description,
      file_count: entries.length,
      created_at: Date.now(),
    })

    for (const e of entries) {
      this.repo.addFile({
        checkpoint_id: id,
        file_path: e.path,
        content: e.content,
        content_hash: e.hash,
        operation: e.operation,
      })
    }

    this.ipc.emit("checkpoint_created", {
      id,
      description,
      files: entries.map(e => e.path),
      created_at: Date.now(),
    })

    return id
  }

  /** Restaura el workspace al estado del checkpoint dado */
  async rollback(checkpointId: string): Promise<void> {
    const files = this.repo.getFiles(checkpointId)
    const restored = await restoreFiles(files)

    this.repo.markRestored(checkpointId)

    this.ipc.emit("rollback_complete", {
      checkpoint_id: checkpointId,
      files_restored: restored.length,
    })
  }

  /** Lista los últimos N checkpoints de la sesión */
  list(limit = 50) {
    return this.repo.list(this.sessionId, limit)
  }

  /** Crea un checkpoint de HALT — congela el estado actual antes de detener */
  async halt(filePaths: string[]): Promise<string> {
    return this.create("HALT snapshot", filePaths, [], "halt")
  }
}
