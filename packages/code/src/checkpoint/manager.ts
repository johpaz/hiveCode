import { randomBytes } from "node:crypto"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CheckpointDoc, CheckpointFileDoc } from "@johpaz/hivecode-core/storage/collections"
import type { IpcEmitter } from "../context/ipc-emitter.ts"
import { snapshotFiles } from "./snapshot.ts"
import { restoreFiles } from "./rollback.ts"

export class CheckpointManager {
  private checkpointCache: CheckpointDoc[] = []

  constructor(
    _db: unknown,
    private sessionId: string,
    private ipc: IpcEmitter,
  ) {}

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
    const entries = await snapshotFiles(filePaths, filesToCreate)
    const now = Date.now()
    const checkpoints = await col<CheckpointDoc>("checkpoints")
    const checkpointFiles = await col<CheckpointFileDoc>("checkpointFiles")

    const checkpoint: CheckpointDoc = {
      id,
      session_id: this.sessionId,
      created_by: createdBy,
      description,
      file_count: entries.length,
      git_stash_ref: null,
      created_at: now,
      restored_at: null,
    }
    this.checkpointCache.push(checkpoint)
    await checkpoints.put(id, checkpoint)

    for (const [index, e] of entries.entries()) {
      const fileId = `${id}:${String(index).padStart(5, "0")}`
      await checkpointFiles.put(fileId, {
        id: fileId,
        checkpoint_id: id,
        file_path: e.path,
        content: e.content.toString("base64"),
        content_hash: e.hash,
        operation: e.operation,
      })
    }

    this.ipc.emit("checkpoint_created", {
      id,
      description,
      files: entries.map(e => e.path),
      created_at: now,
    })

    return id
  }

  /** Restaura el workspace al estado del checkpoint dado */
  async rollback(checkpointId: string): Promise<void> {
    const checkpointFiles = await col<CheckpointFileDoc>("checkpointFiles")
    const files = (await checkpointFiles.findBy("checkpoint_id", checkpointId)).map(entry => ({
      checkpoint_id: entry.doc.checkpoint_id,
      file_path: entry.doc.file_path,
      content: Buffer.from(entry.doc.content, "base64"),
      content_hash: entry.doc.content_hash,
      operation: entry.doc.operation,
    }))
    const restored = await restoreFiles(files)

    const checkpoints = await col<CheckpointDoc>("checkpoints")
    const checkpoint = await checkpoints.get(checkpointId)
    if (checkpoint) {
      this.checkpointCache = this.checkpointCache.map(entry =>
        entry.id === checkpointId ? { ...entry, restored_at: Date.now() } : entry,
      )
      await checkpoints.put(
        checkpointId,
        { ...checkpoint.doc, restored_at: Date.now() },
        { expectedVersion: checkpoint.version },
      )
    }

    this.ipc.emit("rollback_complete", {
      checkpoint_id: checkpointId,
      files_restored: restored.length,
    })
  }

  /** Lista los últimos N checkpoints de la sesión */
  list(limit = 50): CheckpointDoc[] {
    return this.checkpointCache
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit)
  }

  /** Crea un checkpoint de HALT — congela el estado actual antes de detener */
  async halt(filePaths: string[]): Promise<string> {
    return this.create("HALT snapshot", filePaths, [], "halt")
  }
}
