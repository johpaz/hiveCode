import type { Database } from "bun:sqlite"

export type ConflictType = "file_collision" | "decision_clash" | "adr_violation" | "dependency_race"
export type ConflictSeverity = "low" | "medium" | "high" | "critical"

export interface AgentConflict {
  id: number
  session_id: string
  agent_a: string
  agent_b: string
  type: ConflictType
  description: string
  file_path: string | null
  context_id_a: number | null
  context_id_b: number | null
  severity: ConflictSeverity
  resolved: boolean
  resolved_by: string | null
  resolution: string | null
  created_at: number
  resolved_at: number | null
}

export class AgentConflictsRepo {
  constructor(private db: Database) {}

  create(c: {
    sessionId: string
    agentA: string
    agentB: string
    type: ConflictType
    description: string
    filePath?: string
    contextIdA?: number
    contextIdB?: number
    severity: ConflictSeverity
  }): number {
    const res = this.db.run(
      `INSERT INTO agent_conflicts
        (session_id, agent_a, agent_b, type, description,
         file_path, context_id_a, context_id_b, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.sessionId,
        c.agentA,
        c.agentB,
        c.type,
        c.description,
        c.filePath ?? null,
        c.contextIdA ?? null,
        c.contextIdB ?? null,
        c.severity,
        Date.now(),
      ],
    )
    return Number(res.lastInsertRowid)
  }

  listUnresolved(sessionId: string): AgentConflict[] {
    return this.db
      .query("SELECT * FROM agent_conflicts WHERE session_id = ? AND resolved = 0 ORDER BY created_at DESC")
      .all(sessionId) as AgentConflict[]
  }

  resolve(id: number, resolvedBy: "bee" | "human", resolution: string): void {
    this.db.run(
      `UPDATE agent_conflicts
       SET resolved = 1, resolved_by = ?, resolution = ?, resolved_at = ?
       WHERE id = ?`,
      [resolvedBy, resolution, Date.now(), id],
    )
  }

  hasUnresolved(sessionId: string, filePath: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM agent_conflicts
         WHERE session_id = ? AND file_path = ? AND resolved = 0 LIMIT 1`,
      )
      .get(sessionId, filePath)
    return row !== null
  }
}
