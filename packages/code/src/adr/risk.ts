import type { Database } from "bun:sqlite"
import { FileRisksRepo } from "@johpaz/hivecode-core/db/repos/file-risks"
import type { RiskLevel } from "@johpaz/hivecode-core/db/repos/file-risks"
import type { IpcEmitter } from "../context/ipc-emitter.ts"
import { AdrAnalyzer } from "./analyzer.ts"
import type { AdrMatch } from "./analyzer.ts"

export interface FileRiskResult {
  filePath: string
  riskLevel: RiskLevel
  adrRef: string | null
  reason: string
  matches: AdrMatch[]
}

/**
 * Calcula el nivel de riesgo de un archivo basándose en los ADRs que lo afectan.
 *
 * Matriz de riesgo:
 *   - Sin ADRs relevantes                    → low
 *   - ADR de baja relevancia                 → medium
 *   - ADR de media relevancia aceptado       → high
 *   - ADR de alta relevancia aceptado        → critical
 *   - Cualquier ADR si el archivo es schema  → siempre al menos high
 */
export class RiskCalculator {
  private fileRisks: FileRisksRepo
  private analyzer: AdrAnalyzer

  constructor(
    private db: Database,
    private sessionId: string,
    private ipc: IpcEmitter,
  ) {
    this.fileRisks = new FileRisksRepo(db)
    this.analyzer = new AdrAnalyzer(db)
  }

  /**
   * Evalúa el riesgo de un archivo y lo persiste en `file_risks`.
   * Emite `file_risk_update` al TUI por IPC.
   */
  evaluate(
    filePath: string,
    operation: "created" | "modified" | "deleted",
    agent: string,
  ): FileRiskResult {
    const matches = this.analyzer.analyze(filePath)
    const riskLevel = this.computeLevel(filePath, matches)
    const topAdr = matches[0]?.adr

    const result: FileRiskResult = {
      filePath,
      riskLevel,
      adrRef: topAdr ? topAdr.file_path : null,
      reason: this.buildReason(filePath, matches, riskLevel),
      matches,
    }

    this.fileRisks.upsert({
      session_id: this.sessionId,
      file_path: filePath,
      risk_level: riskLevel,
      operation,
      adr_ref: result.adrRef,
      reason: result.reason,
      agent,
    })

    this.ipc.emit("file_risk_update", {
      path: filePath,
      risk: riskLevel,
      operation,
      adr_ref: result.adrRef,
      reason: result.reason,
      agent,
    })

    return result
  }

  private computeLevel(filePath: string, matches: AdrMatch[]): RiskLevel {
    // Archivos de schema/migrations son siempre al menos high
    const isSchemaFile =
      /schema|migration|migrate/i.test(filePath) ||
      filePath.endsWith(".sql")

    if (matches.length === 0) return isSchemaFile ? "high" : "low"

    const highMatch = matches.find(m => m.relevance === "high" && m.adr.status === "accepted")
    if (highMatch) return isSchemaFile ? "critical" : "critical"

    const medMatch = matches.find(m => m.relevance === "medium" && m.adr.status === "accepted")
    if (medMatch) return isSchemaFile ? "critical" : "high"

    return isSchemaFile ? "high" : "medium"
  }

  private buildReason(filePath: string, matches: AdrMatch[], level: RiskLevel): string {
    if (matches.length === 0) {
      return level === "high"
        ? "Archivo de schema — siempre alto riesgo"
        : "Sin ADRs relevantes"
    }
    const top = matches[0]
    return `${top.reason} — ADR: "${top.adr.title}" (${top.adr.status})`
  }

  /** Evalúa una lista de archivos en batch */
  evaluateAll(
    files: Array<{ path: string; operation: "created" | "modified" | "deleted" }>,
    agent: string,
  ): FileRiskResult[] {
    return files.map(f => this.evaluate(f.path, f.operation, agent))
  }
}
