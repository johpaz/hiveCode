import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { AdrDoc } from "@johpaz/hivecode-core/storage/collections"

export type AdrStatus = "accepted" | "deprecated" | "superseded" | "proposed"
export type Adr = AdrDoc

const ADR_CACHE = new Map<string, Adr>()

function parseTitle(content: string): string {
  const m = content.match(/^#\s+(.+)/m)
  return m ? m[1].trim() : "Sin titulo"
}

function parseStatus(content: string): AdrStatus {
  const m = content.match(/\*\*?[Ss]tatus\*\*?:?\s*(\w+)/m)
  const raw = m?.[1]?.toLowerCase() ?? ""
  const valid: AdrStatus[] = ["accepted", "deprecated", "superseded", "proposed"]
  return valid.includes(raw as AdrStatus) ? (raw as AdrStatus) : "accepted"
}

export interface AdrLoaderResult {
  loaded: number
  skipped: number
}

/**
 * Escanea el directorio `adrs/` del proyecto y sincroniza documentos ADR en HiveDB.
 * Re-carga solo si el archivo cambio de mtime.
 */
export class AdrLoader {
  private mtimeCache = new Map<string, number>()

  constructor(_db: unknown) {}

  load(projectPath: string): AdrLoaderResult {
    const adrsDir = path.join(projectPath, "adrs")
    if (!existsSync(adrsDir)) return { loaded: 0, skipped: 0 }

    let loaded = 0
    let skipped = 0

    const files = readdirSync(adrsDir).filter(
      f => f.endsWith(".md") || f.endsWith(".MD"),
    )

    for (const file of files) {
      const filePath = path.join(adrsDir, file)
      const stat = statSync(filePath)
      const mtime = stat.mtimeMs

      const cached = this.mtimeCache.get(filePath)
      if (cached === mtime) {
        skipped++
        continue
      }

      const content = readFileSync(filePath, "utf8")
      const title = parseTitle(content)
      const status = parseStatus(content)
      const id = filePath
      const doc: Adr = {
        id,
        file_path: filePath,
        title,
        status,
        content,
        summary: null,
        updated_at: Math.floor(mtime),
      }

      ADR_CACHE.set(id, doc)
      void persistAdr(id, doc)
      this.mtimeCache.set(filePath, mtime)
      loaded++
    }

    return { loaded, skipped }
  }

  /** Recarga forzada ignorando el cache de mtime. */
  reload(projectPath: string): AdrLoaderResult {
    this.mtimeCache.clear()
    return this.load(projectPath)
  }

  getAll(): Adr[] {
    return getCachedAdrs()
  }
}

export function getCachedAdrs(): Adr[] {
  return [...ADR_CACHE.values()].sort((a, b) => b.updated_at - a.updated_at)
}

async function persistAdr(id: string, doc: Adr): Promise<void> {
  const adrs = await col<AdrDoc>("adrs")
  const existing = await adrs.get(id)
  await adrs.put(id, doc, { expectedVersion: existing?.version ?? 0 })
}
