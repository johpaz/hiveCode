import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import type { NarrativeEntry, ADR, FileSnapshot } from "../workers/types"

export interface Turn {
  id: string
  sessionId: string
  taskId: string | null
  userMessage: string
  agentResponse: string
  createdAt: string
  completedAt: string | null
}

export interface FileChange {
  filePath: string
  changeType: "added" | "modified" | "deleted"
  linesAdded: number
  linesRemoved: number
}

export interface TaskMetadata {
  tokensIn: number
  tokensOut: number
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  durationMs: number
}

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
      "INSERT INTO code_sessions (id, project_path, status) VALUES (?, ?, 'active')"
    ).run(id, projectPath)
    log.info(`[scribe] Session created: ${id} (${projectPath})`)
    return id
  }

  closeSession(sessionId: string): void {
    this.db.query(
      "UPDATE code_sessions SET status = 'closed', last_active = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
    ).run(sessionId)
    log.info(`[scribe] Session closed: ${sessionId}`)
  }

  createTurn(sessionId: string, userMessage: string): string {
    const id = Bun.randomUUIDv7()
    this.db.query(
      "INSERT INTO code_turns (id, session_id, user_message) VALUES (?, ?, ?)"
    ).run(id, sessionId, userMessage)
    return id
  }

  completeTurn(turnId: string, agentResponse: string, taskId?: string | null): void {
    this.db.query(
      "UPDATE code_turns SET agent_response = ?, task_id = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
    ).run(agentResponse, taskId ?? null, turnId)
  }

  getRecentTurns(sessionId: string, limit = 10): Turn[] {
    const rows = this.db.query(`
      SELECT * FROM code_turns
      WHERE session_id = ? AND completed_at IS NOT NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, limit) as any[]
    return rows.reverse().map(r => ({
      id: r.id,
      sessionId: r.session_id,
      taskId: r.task_id,
      userMessage: r.user_message,
      agentResponse: r.agent_response,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }))
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

  updatePhaseMetadata(phaseId: number, tokensIn: number, tokensOut: number, durationMs: number): void {
    this.db.query(
      "UPDATE code_task_phases SET tokens_in = ?, tokens_out = ?, duration_ms = ? WHERE id = ?"
    ).run(tokensIn, tokensOut, durationMs, phaseId)
  }

  updateTaskMetadata(taskId: string, meta: TaskMetadata): void {
    this.db.query(`
      UPDATE code_tasks SET
        tokens_in = tokens_in + ?,
        tokens_out = tokens_out + ?,
        files_changed = ?,
        lines_added = ?,
        lines_removed = ?,
        duration_ms = duration_ms + ?
      WHERE id = ?
    `).run(meta.tokensIn, meta.tokensOut, meta.filesChanged, meta.linesAdded, meta.linesRemoved, meta.durationMs, taskId)
  }

  writeFileChanges(taskId: string, phaseId: number | null, changes: FileChange[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO code_file_changes (task_id, phase_id, file_path, change_type, lines_added, lines_removed)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const c of changes) {
      stmt.run(taskId, phaseId, c.filePath, c.changeType, c.linesAdded, c.linesRemoved)
    }
  }

  writeTrace(trace: {
    taskId: string
    agentId: string
    coordinator: string
    toolName: string
    inputSummary?: string
    outputSummary?: string
    success: boolean
    durationNs?: number
    tokensIn?: number
    tokensOut?: number
  }): void {
    this.db.query(`
      INSERT INTO code_traces
        (task_id, agent_id, coordinator, tool_name, input_summary, output_summary, success, duration_ns, tokens_in, tokens_out, analyzed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      trace.taskId,
      trace.agentId,
      trace.coordinator,
      trace.toolName,
      trace.inputSummary ?? "",
      trace.outputSummary ?? "",
      trace.success ? 1 : 0,
      trace.durationNs ?? 0,
      trace.tokensIn ?? 0,
      trace.tokensOut ?? 0,
    )
  }
}
