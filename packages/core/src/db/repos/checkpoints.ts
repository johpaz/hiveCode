import type { Database } from "bun:sqlite"

export type CheckpointOperation = "created" | "modified" | "deleted"

export interface Checkpoint {
  id: string
  session_id: string
  created_by: string
  description: string
  file_count: number
  git_stash_ref: string | null
  created_at: number
  restored_at: number | null
}

export interface CheckpointFile {
  id: number
  checkpoint_id: string
  file_path: string
  content: Buffer
  content_hash: string
  operation: CheckpointOperation
}

export class CheckpointsRepo {
  constructor(private db: Database) {}

  createCheckpoint(cp: Omit<Checkpoint, "git_stash_ref" | "restored_at">): void {
    this.db.run(
      `INSERT INTO checkpoints (id, session_id, created_by, description, file_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [cp.id, cp.session_id, cp.created_by, cp.description, cp.file_count, cp.created_at],
    )
  }

  addFile(f: Omit<CheckpointFile, "id">): void {
    this.db.run(
      `INSERT INTO checkpoint_files (checkpoint_id, file_path, content, content_hash, operation)
       VALUES (?, ?, ?, ?, ?)`,
      [f.checkpoint_id, f.file_path, f.content, f.content_hash, f.operation],
    )
  }

  getFiles(checkpointId: string): CheckpointFile[] {
    return this.db
      .query("SELECT * FROM checkpoint_files WHERE checkpoint_id = ?")
      .all(checkpointId) as CheckpointFile[]
  }

  list(sessionId: string, limit = 50): Checkpoint[] {
    return this.db
      .query("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(sessionId, limit) as Checkpoint[]
  }

  markRestored(id: string): void {
    this.db.run("UPDATE checkpoints SET restored_at = ? WHERE id = ?", [Date.now(), id])
  }

  lastHash(filePath: string): string | null {
    const row = this.db
      .query(
        "SELECT content_hash FROM checkpoint_files WHERE file_path = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(filePath) as { content_hash: string } | null
    return row?.content_hash ?? null
  }
}
