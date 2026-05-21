import type { Database } from "bun:sqlite"

export interface Message {
  id: number
  session_id: string
  role: "user" | "assistant" | "system" | "worker"
  agent: string | null
  content: string
  content_type: "text" | "markdown" | "code" | "diff"
  created_at: number
}

export class MessagesRepo {
  constructor(private db: Database) {}

  append(m: Omit<Message, "id">): number {
    const res = this.db.run(
      `INSERT INTO messages (session_id, role, agent, content, content_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [m.session_id, m.role, m.agent, m.content, m.content_type ?? "text", m.created_at],
    )
    return Number(res.lastInsertRowid)
  }

  list(sessionId: string, limit = 100): Message[] {
    return this.db
      .query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, limit) as Message[]
  }
}
