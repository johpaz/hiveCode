import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import * as path from "node:path"
import type { CheckpointFile } from "@johpaz/hivecode-core/db/repos/checkpoints"

/**
 * Restaura archivos a su estado previo al checkpoint.
 *
 * Semántica de 'operation' (lo que HIZO el agente):
 *   'created'  → el agente creó el archivo — rollback = eliminarlo
 *   'modified' → el agente lo modificó    — rollback = restaurar contenido previo
 *   'deleted'  → el agente lo eliminó     — rollback = restaurar contenido previo
 */
export async function restoreFiles(files: CheckpointFile[]): Promise<string[]> {
  const restored: string[] = []

  for (const file of files) {
    switch (file.operation) {
      case "created":
        // El archivo no existía antes — rollback = eliminarlo
        if (existsSync(file.file_path)) {
          unlinkSync(file.file_path)
          restored.push(file.file_path)
        }
        break

      case "modified":
      case "deleted": {
        // Contenido previo guardado comprimido — restaurar
        const dir = path.dirname(file.file_path)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        // Bug-B fix: Bun.zstdDecompressSync en lugar de Bun.zstd.decompress
        const content =
          file.content.length > 0
            ? Buffer.from(Bun.zstdDecompressSync(file.content))
            : Buffer.alloc(0)
        writeFileSync(file.file_path, content)
        restored.push(file.file_path)
        break
      }
    }
  }

  return restored
}
