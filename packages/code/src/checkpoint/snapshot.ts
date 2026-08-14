import { createHash } from "node:crypto"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CheckpointFileDoc } from "@johpaz/hivecode-core/storage/collections"

export type CheckpointOperation = "created" | "modified" | "deleted"

export interface FileEntry {
  path: string
  content: Buffer
  hash: string
  operation: CheckpointOperation
}

/**
 * Genera el snapshot de una lista de rutas.
 *
 * - filePaths: archivos que EXISTEN y serán modificados → operation 'modified'
 * - filesToCreate: rutas que el agente VA A crear (aún no existen) → operation 'created'
 *
 * Bug-E fix: dos loops separados — el continue en el loop de existentes nunca
 * llegaba al branch 'created', haciendo imposible registrar archivos nuevos.
 */
export async function snapshotFiles(
  filePaths: string[],
  filesToCreate: string[],
): Promise<FileEntry[]> {
  const entries: FileEntry[] = []

  // Loop 1: archivos existentes → snapshot del contenido previo (modified)
  for (const path of filePaths) {
    if (!await Bun.file(path).exists()) continue
    const content = await Bun.file(path).bytes()
    const hash = createHash("sha256").update(content).digest("hex")
    const prevHash = await lastHash(path)
    if (prevHash === hash) continue  // sin cambios — no guardar
    // Bug-B fix: Bun.zstdCompressSync en lugar de Bun.zstd.compress
    entries.push({
      path,
      content: Buffer.from(Bun.zstdCompressSync(content)),
      hash,
      operation: "modified",
    })
  }

  // Loop 2: archivos que el agente va a crear (aún no existen) → 'created'
  // Rollback = eliminar el archivo. No hay contenido previo.
  for (const path of filesToCreate) {
    if (await Bun.file(path).exists()) {
      // Ya existe → tratarlo como modified
      const content = await Bun.file(path).bytes()
      const hash = createHash("sha256").update(content).digest("hex")
      entries.push({
        path,
        content: Buffer.from(Bun.zstdCompressSync(content)),
        hash,
        operation: "modified",
      })
    } else {
      entries.push({
        path,
        content: Buffer.alloc(0),
        hash: "",
        operation: "created",
      })
    }
  }

  return entries
}

async function lastHash(filePath: string): Promise<string | null> {
  const files = await col<CheckpointFileDoc>("checkpointFiles")
  const matches = (await files.scan())
    .filter(entry => entry.doc.file_path === filePath)
    .sort((a, b) => b.id.localeCompare(a.id))
  return matches[0]?.doc.content_hash ?? null
}
