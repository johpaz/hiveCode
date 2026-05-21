import * as path from "node:path"
import type { Database } from "bun:sqlite"
import { AdrsRepo } from "@johpaz/hivecode-core/db/repos/adrs"
import type { Adr } from "@johpaz/hivecode-core/db/repos/adrs"

export interface AdrMatch {
  adr: Adr
  relevance: "high" | "medium" | "low"
  reason: string
}

/**
 * Cruza un archivo del workspace con los ADRs indexados.
 *
 * Estrategia en dos pasos:
 * 1. Coincidencia de ruta — si el ADR menciona el directorio o extensión del archivo
 * 2. Búsqueda FTS5 — keywords extraídos del nombre del archivo contra el contenido del ADR
 */
export class AdrAnalyzer {
  private repo: AdrsRepo

  constructor(private db: Database) {
    this.repo = new AdrsRepo(db)
  }

  /**
   * Retorna los ADRs relevantes para un archivo dado.
   * @param filePath Ruta relativa o absoluta al archivo
   */
  analyze(filePath: string): AdrMatch[] {
    const matches: AdrMatch[] = []
    const seen = new Set<number>()

    const basename = path.basename(filePath, path.extname(filePath))
    const ext = path.extname(filePath).replace(".", "")
    const segments = filePath.split(path.sep).filter(Boolean)

    const allAdrs = this.repo.getAll()

    // Paso 1: coincidencia de ruta/extensión en el contenido del ADR
    for (const adr of allAdrs) {
      if (seen.has(adr.id)) continue
      const lower = adr.content.toLowerCase()

      if (
        segments.some(s => s.length > 2 && lower.includes(s.toLowerCase())) ||
        (ext && lower.includes(`.${ext}`))
      ) {
        const reason = segments.find(s => s.length > 2 && lower.includes(s.toLowerCase())) ?? ext
        matches.push({ adr, relevance: "medium", reason: `ruta coincide: "${reason}"` })
        seen.add(adr.id)
      }
    }

    // Paso 2: FTS5 con el nombre base del archivo como query
    if (basename.length > 2) {
      const ftsResults = this.repo.search(basename, 5)
      for (const adr of ftsResults) {
        if (seen.has(adr.id)) continue
        matches.push({ adr, relevance: "low", reason: `FTS5 match: "${basename}"` })
        seen.add(adr.id)
      }
    }

    // Elevar relevancia a 'high' si el ADR tiene status aceptado y el archivo
    // está explícitamente mencionado en el título del ADR
    for (const m of matches) {
      if (
        m.adr.status === "accepted" &&
        m.adr.title.toLowerCase().includes(basename.toLowerCase())
      ) {
        m.relevance = "high"
        m.reason = `título ADR menciona "${basename}"`
      }
    }

    return matches
  }

  /** Busca ADRs por query libre (FTS5) */
  search(query: string, limit = 5): Adr[] {
    return this.repo.search(query, limit)
  }
}
