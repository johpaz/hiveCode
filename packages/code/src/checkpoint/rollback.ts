import { mkdirSync } from "node:fs"
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
        if (await Bun.file(file.file_path).exists()) {
          await Bun.file(file.file_path).delete()
          restored.push(file.file_path)
        }
        break

      case "modified":
      case "deleted": {
        // Contenido previo guardado comprimido — restaurar
        const dir = path.dirname(file.file_path)
        // Bun has no native directory API; use node:fs for mkdir
        try {
          mkdirSync(dir, { recursive: true })
        } catch { /* directory may already exist */ }
        // Bug-B fix: Bun.zstdDecompressSync en lugar de Bun.zstd.decompress
        const content =
          file.content.length > 0
            ? Buffer.from(Bun.zstdDecompressSync(file.content))
            : Buffer.alloc(0)
        await Bun.write(file.file_path, content)
        restored.push(file.file_path)
        break
      }
    }
  }

  return restored
}
