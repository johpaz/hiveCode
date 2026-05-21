import type { Database } from "bun:sqlite"

export interface Session {
  id: string
  project_path: string
  project_name: string
  started_at: number
  ended_at: number | null
  mode: "plan" | "approval" | "auto"
  provider: string
  model: string
  version: string
  token_count: number
  cost_usd: number
}

export class SessionsRepo {
  constructor(private db: Database) {}

  create(s: Omit<Session, "ended_at" | "token_count" | "cost_usd">): void {
    this.db.run(
      `INSERT INTO sessions (id, project_path, project_name, started_at, mode, provider, model, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.project_path, s.project_name, s.started_at, s.mode, s.provider, s.model, s.version],
    )
  }

  get(id: string): Session | null {
    return this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Session | null
  }

  end(id: string): void {
    this.db.run("UPDATE sessions SET ended_at = ? WHERE id = ?", [Date.now(), id])
  }

  addTokens(id: string, inputTokens: number, outputTokens: number, costUsd: number): void {
    this.db.run(
      `UPDATE sessions
       SET token_count = token_count + ?, cost_usd = cost_usd + ?
       WHERE id = ?`,
      [inputTokens + outputTokens, costUsd, id],
    )
  }

  setMode(id: string, mode: Session["mode"]): void {
    this.db.run("UPDATE sessions SET mode = ? WHERE id = ?", [mode, id])
  }
}
