import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { logger } from "@johpaz/hive-code-core/utils/logger"
import type { NarrativeEntry, ADR, FileSnapshot } from "../workers/types"

const log = logger.child("scribe")

function mapEntry(r: any): NarrativeEntry {
  return {
    id: r.id, taskId: r.task_id, sessionId: r.session_id,
    coordinator: r.coordinator, phase: r.phase, entry: r.entry,
    isDraft: r.is_draft === 1, isOverride: r.is_override === 1,
    createdAt: r.created_at,
  }
}

function mapADR(r: any): ADR {
  return {
    id: r.id, taskId: r.task_id, title: r.title, context: r.context,
    options: r.options, decision: r.decision, consequences: r.consequences,
    status: r.status, createdAt: r.created_at,
  }
}

function mapSnapshot(r: any): FileSnapshot {
  return {
    id: r.id, taskId: r.task_id, filePath: r.file_path,
    content: r.content, hash: r.hash, snapshotAt: r.snapshot_at,
  }
}

export class Scribe {
  private db = getDb()

  createSession(projectPath: string): string {
    const id = Bun.randomUUIDv7()
    this.db.query(
      "INSERT INTO code_sessions (id, project_path) VALUES (?, ?)"
    ).run(id, projectPath)
    log.info(`[scribe] Session created: ${id} (${projectPath})`)
    return id
  }

  createTask(sessionId: string, description: string, mode: string): string {
    const id = Bun.randomUUIDv7()
    this.db.query(
      "INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', ?)"
    ).run(id, sessionId, description, mode)
    log.info(`[scribe] Task created: ${id} — ${description.slice(0, 60)}`)
    return id
  }

  updateTaskStatus(taskId: string, status: string, extra?: { branchName?: string; prUrl?: string }): void {
    const sets = ["status = ?", "completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ELSE NULL END"]
    const params: unknown[] = [status, status]
    if (extra?.branchName) { sets.push("branch_name = ?"); params.push(extra.branchName) }
    if (extra?.prUrl) { sets.push("pr_url = ?"); params.push(extra.prUrl) }
    params.push(taskId)
    this.db.query(`UPDATE code_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params as [string, string, string])
  }

  createPhase(taskId: string, phaseName: string, coordinator: string): number {
    const result = this.db.query(
      "INSERT INTO code_task_phases (task_id, phase_name, coordinator, status) VALUES (?, ?, ?, 'pending') RETURNING id"
    ).get(taskId, phaseName, coordinator) as { id: number }
    return result.id
  }

  updatePhaseStatus(phaseId: number, status: string, resultSummary?: string): void {
    const sets = ["status = ?"]
    const params: unknown[] = [status]
    if (status === "running") { sets.push("started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')") }
    if (status === "completed" || status === "failed") { sets.push("completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')") }
    if (resultSummary) { sets.push("result_summary = ?"); params.push(resultSummary) }
    params.push(phaseId)
    this.db.query(`UPDATE code_task_phases SET ${sets.join(", ")} WHERE id = ?`).run(...params as [string, string, string, string])
  }

  logModeChange(sessionId: string, mode: string, taskId?: string, phaseName?: string): void {
    this.db.query(
      "INSERT INTO code_session_modes (session_id, task_id, mode, phase_at_change, triggered_by) VALUES (?, ?, ?, ?, 'cli')"
    ).run(sessionId, taskId || null, mode, phaseName || null)
  }

  appendNarrative(entry: NarrativeEntry): number {
    const result = this.db.query(`
      INSERT INTO code_narrative (task_id, session_id, coordinator, phase, entry, is_draft, is_override)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).get(
      entry.taskId, entry.sessionId, entry.coordinator, entry.phase || null,
      entry.entry, entry.isDraft ? 1 : 0, entry.isOverride ? 1 : 0
    ) as { id: number }
    return result.id
  }

  readNarrative(taskId?: string, lastN = 50): NarrativeEntry[] {
    if (taskId) {
      const rows = this.db.query(
        "SELECT * FROM code_narrative WHERE task_id = ? ORDER BY id DESC LIMIT ?"
      ).all(taskId, lastN) as any[]
      return rows.map(mapEntry).reverse()
    }
    const rows = this.db.query(
      "SELECT * FROM code_narrative ORDER BY id DESC LIMIT ?"
    ).all(lastN) as any[]
    return rows.map(mapEntry).reverse()
  }

  searchNarrative(query: string): NarrativeEntry[] {
    const rows = this.db.query(
      `SELECT n.* FROM code_narrative n
       JOIN code_narrative_fts fts ON n.id = fts.rowid
       WHERE code_narrative_fts MATCH ? ORDER BY rank LIMIT 20`
    ).all(query) as any[]
    return rows.map(mapEntry)
  }

  writeDecision(adr: ADR): void {
    this.db.query(
      "INSERT INTO code_decisions (id, task_id, title, context, options, decision, consequences, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(adr.id, adr.taskId, adr.title, adr.context, adr.options, adr.decision, adr.consequences, adr.status)
  }

  readDecisions(status?: string): ADR[] {
    if (status) {
      const rows = this.db.query(
        "SELECT * FROM code_decisions WHERE status = ? ORDER BY created_at DESC"
      ).all(status) as any[]
      return rows.map(mapADR)
    }
    const rows = this.db.query("SELECT * FROM code_decisions ORDER BY created_at DESC").all() as any[]
    return rows.map(mapADR)
  }

  saveSnapshot(taskId: string, filePath: string, content: string, hash: string): void {
    this.db.query(
      "INSERT INTO code_file_snapshots (task_id, file_path, content, hash) VALUES (?, ?, ?, ?)"
    ).run(taskId, filePath, content, hash)
  }

  getSnapshots(taskId: string): FileSnapshot[] {
    const rows = this.db.query(
      "SELECT * FROM code_file_snapshots WHERE task_id = ? ORDER BY id"
    ).all(taskId) as any[]
    return rows.map(mapSnapshot)
  }

  deleteSnapshots(taskId: string): void {
    this.db.query("DELETE FROM code_file_snapshots WHERE task_id = ?").run(taskId)
  }

  getTaskContext(taskId: string): { narrative: NarrativeEntry[]; decisions: ADR[]; files: FileSnapshot[] } {
    return {
      narrative: this.readNarrative(taskId),
      decisions: this.readDecisions().filter(d => d.taskId === taskId),
      files: this.getSnapshots(taskId),
    }
  }
}
