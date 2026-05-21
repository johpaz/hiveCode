import type { Database } from "bun:sqlite"

export type RiskLevel = "low" | "medium" | "high" | "critical"

export interface FileRisk {
  id: number
  session_id: string
  file_path: string
  risk_level: RiskLevel
  operation: string | null
  adr_ref: string | null
  reason: string | null
  agent: string | null
  updated_at: number
}

export class FileRisksRepo {
  constructor(private db: Database) {}

  upsert(r: Omit<FileRisk, "id" | "updated_at">): void {
    this.db.run(
      `INSERT INTO file_risks (session_id, file_path, risk_level, operation, adr_ref, reason, agent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, file_path) DO UPDATE SET
         risk_level = excluded.risk_level,
         operation  = excluded.operation,
         adr_ref    = excluded.adr_ref,
         reason     = excluded.reason,
         agent      = excluded.agent,
         updated_at = excluded.updated_at`,
      [
        r.session_id,
        r.file_path,
        r.risk_level,
        r.operation,
        r.adr_ref,
        r.reason,
        r.agent,
        Date.now(),
      ],
    )
  }

  listBySession(sessionId: string): FileRisk[] {
    return this.db
      .query("SELECT * FROM file_risks WHERE session_id = ? ORDER BY updated_at DESC")
      .all(sessionId) as FileRisk[]
  }

  getByFile(sessionId: string, filePath: string): FileRisk | null {
    return this.db
      .query("SELECT * FROM file_risks WHERE session_id = ? AND file_path = ?")
      .get(sessionId, filePath) as FileRisk | null
  }

  getByAgent(sessionId: string, agent: string, sinceMs: number): FileRisk[] {
    return this.db
      .query(
        "SELECT * FROM file_risks WHERE session_id = ? AND agent = ? AND updated_at > ?",
      )
      .all(sessionId, agent, sinceMs) as FileRisk[]
  }
}
