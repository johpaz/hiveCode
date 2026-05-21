import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"
import type { Database } from "bun:sqlite"
import { AdrsRepo } from "@johpaz/hivecode-core/db/repos/adrs"
import type { AdrStatus } from "@johpaz/hivecode-core/db/repos/adrs"

// Extrae el título de la primera línea H1 del markdown
function parseTitle(content: string): string {
  const m = content.match(/^#\s+(.+)/m)
  return m ? m[1].trim() : "Sin título"
}

// Extrae el status del campo "Status:" en el markdown
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
 * Escanea el directorio `adrs/` del proyecto, indexa o actualiza cada ADR
 * en la tabla `adrs` + FTS5. Re-carga solo si el archivo cambió (mtime).
 */
export class AdrLoader {
  private repo: AdrsRepo
  // mtime por ruta para detectar cambios
  private mtimeCache = new Map<string, number>()

  constructor(private db: Database) {
    this.repo = new AdrsRepo(db)
  }

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

      this.repo.upsert({
        file_path: filePath,
        title,
        status,
        content,
        summary: null,
        updated_at: Math.floor(mtime),
      })

      this.mtimeCache.set(filePath, mtime)
      loaded++
    }

    return { loaded, skipped }
  }

  /** Recarga forzada ignorando el caché de mtime */
  reload(projectPath: string): AdrLoaderResult {
    this.mtimeCache.clear()
    return this.load(projectPath)
  }

  getAll() {
    return this.repo.getAll()
  }
}
