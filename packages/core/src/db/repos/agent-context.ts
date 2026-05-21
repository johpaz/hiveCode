import type { Database } from "bun:sqlite"

export type ContextType = "decision" | "constraint" | "reasoning" | "observation" | "question" | "answer"
export type ContextStatus = "active" | "superseded" | "resolved" | "rejected"
export type ContextScope = "session" | "project" | "global"

export interface ContextEntry {
  id: number
  session_id: string
  agent: string
  type: ContextType
  content: string
  status: ContextStatus
  scope: ContextScope
  file_path: string | null
  parent_id: number | null
  resolved_by: string | null
  created_at: number
  updated_at: number
}

export interface WorkerAwareness {
  session_id: string
  worker: string
  phase: string | null
  status: string | null
  last_known_action: string | null
  last_known_file: string | null
  confidence: number
  last_decision: string | null
  has_conflict: boolean
  conflict_count: number
}

export class AgentContextRepo {
  constructor(private db: Database) {}

  write(
    sessionId: string,
    agent: string,
    type: ContextType,
    content: string,
    options?: { filePath?: string; parentId?: number; scope?: ContextScope },
  ): number {
    const now = Date.now()
    const res = this.db.run(
      `INSERT INTO agent_context
        (session_id, agent, type, content, file_path, parent_id, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        agent,
        type,
        content,
        options?.filePath ?? null,
        options?.parentId ?? null,
        options?.scope ?? "session",
        now,
        now,
      ],
    )
    const id = Number(res.lastInsertRowid)
    // Sync FTS5 — content= table requires manual insert
    this.db.run(
      "INSERT INTO agent_context_fts(rowid, content, agent, type) VALUES (?, ?, ?, ?)",
      [id, content, agent, type],
    )
    return id
  }

  readRelevant(sessionId: string, options?: { filePath?: string; query?: string }): ContextEntry[] {
    if (options?.query) {
      return this.db
        .query(
          `SELECT * FROM agent_context
           WHERE id IN (
             SELECT rowid FROM agent_context_fts WHERE agent_context_fts MATCH ?
           )
           AND session_id = ?
           AND status     = 'active'
           ORDER BY created_at DESC LIMIT 20`,
        )
        .all(options.query, sessionId) as ContextEntry[]
    }
    if (options?.filePath) {
      return this.db
        .query(
          `SELECT * FROM agent_context
           WHERE session_id = ?
           AND   status     = 'active'
           AND   (file_path = ? OR file_path IS NULL)
           ORDER BY created_at DESC LIMIT 30`,
        )
        .all(sessionId, options.filePath) as ContextEntry[]
    }
    return this.db
      .query(
        `SELECT * FROM agent_context
         WHERE session_id = ?
         AND   status     = 'active'
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all(sessionId) as ContextEntry[]
  }

  supersede(id: number, replacedBy: string): void {
    this.db.run(
      "UPDATE agent_context SET status = 'superseded', resolved_by = ?, updated_at = ? WHERE id = ?",
      [replacedBy, Date.now(), id],
    )
  }

  resolve(id: number, resolvedBy: string): void {
    this.db.run(
      "UPDATE agent_context SET status = 'resolved', resolved_by = ?, updated_at = ? WHERE id = ?",
      [resolvedBy, Date.now(), id],
    )
  }

  beeAwareness(sessionId: string): WorkerAwareness[] {
    return this.db
      .query("SELECT * FROM bee_awareness WHERE session_id = ?")
      .all(sessionId) as WorkerAwareness[]
  }

  getConstraints(sessionId: string, filePath: string): ContextEntry[] {
    return this.db
      .query(
        `SELECT * FROM agent_context
         WHERE session_id = ?
         AND   type       = 'constraint'
         AND   status     = 'active'
         AND   file_path  = ?`,
      )
      .all(sessionId, filePath) as ContextEntry[]
  }
}
