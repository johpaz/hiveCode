import type { Database } from "bun:sqlite"

export type AdrStatus = "accepted" | "deprecated" | "superseded" | "proposed"

export interface Adr {
  id: number
  file_path: string
  title: string
  status: AdrStatus
  content: string
  summary: string | null
  updated_at: number
}

export class AdrsRepo {
  constructor(private db: Database) {}

  upsert(adr: Omit<Adr, "id">): number {
    const existing = this.db
      .query("SELECT id FROM adrs WHERE file_path = ?")
      .get(adr.file_path) as { id: number } | null

    if (existing) {
      this.db.run(
        `UPDATE adrs SET title = ?, status = ?, content = ?, summary = ?, updated_at = ?
         WHERE file_path = ?`,
        [adr.title, adr.status, adr.content, adr.summary, adr.updated_at, adr.file_path],
      )
      this.db.run(
        "UPDATE adrs_fts SET title = ?, content = ? WHERE rowid = ?",
        [adr.title, adr.content, existing.id],
      )
      return existing.id
    }

    const res = this.db.run(
      `INSERT INTO adrs (file_path, title, status, content, summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [adr.file_path, adr.title, adr.status, adr.content, adr.summary, adr.updated_at],
    )
    const id = Number(res.lastInsertRowid)
    this.db.run(
      "INSERT INTO adrs_fts(rowid, title, content) VALUES (?, ?, ?)",
      [id, adr.title, adr.content],
    )
    return id
  }

  search(query: string, limit = 5): Adr[] {
    return this.db
      .query(
        `SELECT a.* FROM adrs a
         WHERE a.id IN (
           SELECT rowid FROM adrs_fts WHERE adrs_fts MATCH ?
         )
         LIMIT ?`,
      )
      .all(query, limit) as Adr[]
  }

  getAll(): Adr[] {
    return this.db.query("SELECT * FROM adrs ORDER BY updated_at DESC").all() as Adr[]
  }

  getByPath(filePath: string): Adr | null {
    return this.db.query("SELECT * FROM adrs WHERE file_path = ?").get(filePath) as Adr | null
  }

  setSummary(id: number, summary: string): void {
    this.db.run("UPDATE adrs SET summary = ?, updated_at = ? WHERE id = ?", [summary, Date.now(), id])
  }
}
