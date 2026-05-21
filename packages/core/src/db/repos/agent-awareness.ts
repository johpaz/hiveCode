import type { Database } from "bun:sqlite"

export type WorkerStatus = "waiting" | "running" | "done" | "failed"

export interface AwarenessEntry {
  session_id: string
  observer: string
  observed: string
  phase: string | null
  status: WorkerStatus | null
  last_known_action: string | null
  last_known_file: string | null
  pending_question: number | null
  confidence: number
  updated_at: number
}

export class AgentAwarenessRepo {
  constructor(private db: Database) {}

  upsert(entry: Omit<AwarenessEntry, "updated_at">): void {
    this.db.run(
      `INSERT INTO agent_awareness
        (session_id, observer, observed, phase, status,
         last_known_action, last_known_file, pending_question, confidence, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, observer, observed) DO UPDATE SET
         phase             = excluded.phase,
         status            = excluded.status,
         last_known_action = excluded.last_known_action,
         last_known_file   = excluded.last_known_file,
         pending_question  = excluded.pending_question,
         confidence        = excluded.confidence,
         updated_at        = excluded.updated_at`,
      [
        entry.session_id,
        entry.observer,
        entry.observed,
        entry.phase,
        entry.status,
        entry.last_known_action,
        entry.last_known_file,
        entry.pending_question,
        entry.confidence,
        Date.now(),
      ],
    )
  }

  setPendingQuestion(sessionId: string, observedWorker: string, questionId: number): void {
    this.db.run(
      `UPDATE agent_awareness
       SET pending_question = ?, updated_at = ?
       WHERE session_id = ? AND observer = 'bee' AND observed = ?`,
      [questionId, Date.now(), sessionId, observedWorker],
    )
  }

  decayConfidence(sessionId: string, decayFactor = 0.95): void {
    this.db.run(
      `UPDATE agent_awareness
       SET confidence = confidence * ?, updated_at = ?
       WHERE session_id = ? AND observer = 'bee'`,
      [decayFactor, Date.now(), sessionId],
    )
  }

  getAll(sessionId: string): AwarenessEntry[] {
    return this.db
      .query("SELECT * FROM agent_awareness WHERE session_id = ? AND observer = 'bee'")
      .all(sessionId) as AwarenessEntry[]
  }
}
