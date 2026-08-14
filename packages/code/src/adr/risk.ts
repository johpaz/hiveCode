import { col } from "@johpaz/hivecode-core/storage/hive"
import type { FileRiskDoc } from "@johpaz/hivecode-core/storage/collections"
import type { IpcEmitter } from "../context/ipc-emitter.ts"
import { AdrAnalyzer } from "./analyzer.ts"
import type { AdrMatch } from "./analyzer.ts"

export type RiskLevel = "low" | "medium" | "high" | "critical"

export interface FileRiskResult {
  filePath: string
  riskLevel: RiskLevel
  adrRef: string | null
  reason: string
  matches: AdrMatch[]
}

/**
 * Calcula el nivel de riesgo de un archivo basandose en los ADRs que lo afectan.
 */
export class RiskCalculator {
  private analyzer: AdrAnalyzer

  constructor(
    _db: unknown,
    private sessionId: string,
    private ipc: IpcEmitter,
  ) {
    this.analyzer = new AdrAnalyzer(_db)
  }

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

    void this.persistRisk(filePath, operation, agent, result)

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
    const isSchemaFile =
      /schema|migration|migrate/i.test(filePath) ||
      filePath.endsWith(".sql")

    if (matches.length === 0) return isSchemaFile ? "high" : "low"

    const highMatch = matches.find(m => m.relevance === "high" && m.adr.status === "accepted")
    if (highMatch) return "critical"

    const medMatch = matches.find(m => m.relevance === "medium" && m.adr.status === "accepted")
    if (medMatch) return isSchemaFile ? "critical" : "high"

    return isSchemaFile ? "high" : "medium"
  }

  private buildReason(filePath: string, matches: AdrMatch[], level: RiskLevel): string {
    if (matches.length === 0) {
      return level === "high"
        ? "Archivo de schema: siempre alto riesgo"
        : "Sin ADRs relevantes"
    }
    const top = matches[0]
    return `${top.reason}: ADR "${top.adr.title}" (${top.adr.status})`
  }

  evaluateAll(
    files: Array<{ path: string; operation: "created" | "modified" | "deleted" }>,
    agent: string,
  ): FileRiskResult[] {
    return files.map(f => this.evaluate(f.path, f.operation, agent))
  }

  private async persistRisk(
    filePath: string,
    operation: "created" | "modified" | "deleted",
    agent: string,
    result: FileRiskResult,
  ): Promise<void> {
    const risks = await col<FileRiskDoc>("fileRisks")
    const id = `${this.sessionId}:${agent}:${filePath}`
    const existing = await risks.get(id)
    await risks.put(
      id,
      {
        id,
        session_id: this.sessionId,
        file_path: filePath,
        risk_level: result.riskLevel,
        operation,
        adr_ref: result.adrRef,
        reason: result.reason,
        agent,
        updated_at: Date.now(),
      },
      { expectedVersion: existing?.version ?? 0 },
    )
  }
}
