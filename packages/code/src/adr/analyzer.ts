import * as path from "node:path"
import { getCachedAdrs, type Adr } from "./loader.ts"

export interface AdrMatch {
  adr: Adr
  relevance: "high" | "medium" | "low"
  reason: string
}

/**
 * Cruza un archivo del workspace con los ADRs cargados.
 *
 * Estrategia:
 * 1. Coincidencia de ruta: el ADR menciona el directorio o extension del archivo.
 * 2. Coincidencia textual: palabras del nombre del archivo aparecen en titulo o contenido.
 */
export class AdrAnalyzer {
  constructor(_db: unknown) {}

  analyze(filePath: string): AdrMatch[] {
    const matches: AdrMatch[] = []
    const seen = new Set<string>()

    const basename = path.basename(filePath, path.extname(filePath))
    const ext = path.extname(filePath).replace(".", "")
    const segments = filePath.split(path.sep).filter(Boolean)

    const allAdrs = getCachedAdrs()

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

    if (basename.length > 2) {
      for (const adr of this.search(basename, 5)) {
        if (seen.has(adr.id)) continue
        matches.push({ adr, relevance: "low", reason: `texto coincide: "${basename}"` })
        seen.add(adr.id)
      }
    }

    for (const m of matches) {
      if (
        m.adr.status === "accepted" &&
        m.adr.title.toLowerCase().includes(basename.toLowerCase())
      ) {
        m.relevance = "high"
        m.reason = `titulo ADR menciona "${basename}"`
      }
    }

    return matches
  }

  search(query: string, limit = 5): Adr[] {
    const needle = query.toLowerCase()
    return getCachedAdrs()
      .filter(adr =>
        adr.title.toLowerCase().includes(needle) ||
        adr.content.toLowerCase().includes(needle) ||
        (adr.summary?.toLowerCase().includes(needle) ?? false),
      )
      .slice(0, limit)
  }
}
