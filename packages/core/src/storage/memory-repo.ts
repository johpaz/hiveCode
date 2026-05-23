import type { Database } from "bun:sqlite"
import { getMemoryDb } from "./memory-db"

export type MemoryType = "pattern" | "antipattern" | "contract" | "convention" | "forensic_lesson"
export type MemorySeverity = "critical" | "high" | "medium" | "low"

export interface MemoryEntry {
  id?: number
  project_id: string
  session_origin: string
  agent: string
  type: MemoryType
  content: string
  severity: MemorySeverity
  confirmed_count?: number
  refuted_count?: number
  last_used_at?: number
  created_at?: number
  updated_at?: number
  deprecated?: number
}

export interface MemoryRecord {
  id: number
  project_id: string
  session_origin: string
  agent: string
  type: MemoryType
  content: string
  severity: MemorySeverity
  confirmed_count: number
  refuted_count: number
  last_used_at: number | null
  created_at: number
  updated_at: number
  deprecated: number
}

export class MemoryRepo {
  private get db(): Database {
    return getMemoryDb()
  }

  upsert(entry: MemoryEntry): number {
    const now = Date.now()
    const existing = this.db.query<{ id: number }, [string, string, string]>(
      `SELECT id FROM agent_memory WHERE project_id = ? AND type = ? AND content = ? AND deprecated = 0 LIMIT 1`
    ).get(entry.project_id, entry.type, entry.content)

    if (existing) {
      this.db.query(
        `UPDATE agent_memory SET agent = ?, severity = ?, session_origin = ?, updated_at = ? WHERE id = ?`
      ).run(entry.agent, entry.severity, entry.session_origin, now, existing.id)
      return existing.id
    }

    const result = this.db.query(
      `INSERT INTO agent_memory (project_id, session_origin, agent, type, content, severity, confirmed_count, refuted_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
    ).run(entry.project_id, entry.session_origin, entry.agent, entry.type, entry.content, entry.severity, now, now)
    return Number(result.lastInsertRowid)
  }

  /** FTS5 semantic search filtered by project, ordered by severity then confirmed count */
  searchByRelevance(projectId: string, query: string, limit = 8): MemoryRecord[] {
    if (!query.trim()) return this.getByProject(projectId, limit)
    try {
      return this.db.query<MemoryRecord, [string, string, number]>(`
        SELECT m.*
        FROM agent_memory m
        JOIN agent_memory_fts f ON m.id = f.rowid
        WHERE m.project_id = ?
          AND m.deprecated = 0
          AND agent_memory_fts MATCH ?
        ORDER BY
          CASE m.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          m.confirmed_count DESC
        LIMIT ?
      `).all(projectId, query, limit)
    } catch {
      return this.getByProject(projectId, limit)
    }
  }

  getByProject(projectId: string, limit = 20): MemoryRecord[] {
    return this.db.query<MemoryRecord, [string, number]>(`
      SELECT * FROM agent_memory
      WHERE project_id = ? AND deprecated = 0
      ORDER BY
        CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        confirmed_count DESC
      LIMIT ?
    `).all(projectId, limit)
  }

  incrementConfirmed(id: number): void {
    const now = Date.now()
    this.db.query(
      `UPDATE agent_memory SET confirmed_count = confirmed_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?`
    ).run(now, now, id)
  }

  /** +1 refuted; deprecates automatically when refuted_count > confirmed_count + 2 */
  incrementRefuted(id: number): void {
    const now = Date.now()
    this.db.query(
      `UPDATE agent_memory SET refuted_count = refuted_count + 1, updated_at = ? WHERE id = ?`
    ).run(now, id)
    const row = this.db.query<{ refuted_count: number; confirmed_count: number }, [number]>(
      `SELECT refuted_count, confirmed_count FROM agent_memory WHERE id = ?`
    ).get(id)
    if (row && row.refuted_count > row.confirmed_count + 2) {
      this.deprecate(id)
    }
  }

  deprecate(id: number): void {
    this.db.query(
      `UPDATE agent_memory SET deprecated = 1, updated_at = ? WHERE id = ?`
    ).run(Date.now(), id)
  }

  updateLastUsed(id: number): void {
    const now = Date.now()
    this.db.query(
      `UPDATE agent_memory SET last_used_at = ?, updated_at = ? WHERE id = ?`
    ).run(now, now, id)
  }
}
