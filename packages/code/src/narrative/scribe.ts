import { col } from "@johpaz/hivecode-core/storage/hive"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import type {
  CodeDecisionDoc,
  CodeFileChangeDoc,
  CodeFileSnapshotDoc,
  CodeNarrativeDoc,
  CodeRecoveryPointDoc,
  CodeSessionDoc,
  CodeSessionModeDoc,
  CodeTaskDoc,
  CodeTaskPhaseDoc,
  CodeTaskPlanDoc,
  CodeTraceDoc,
  CodeTurnDoc,
  LearningFailureDoc,
  LearningProposalDoc,
} from "@johpaz/hivecode-core/storage/collections"
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

function nowIso(): string {
  return new Date().toISOString()
}

function nextNumericId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000)
}

function mapEntry(r: CodeNarrativeDoc): NarrativeEntry {
  return {
    id: Number(r.id),
    taskId: r.task_id,
    sessionId: r.session_id,
    coordinator: r.coordinator,
    phase: r.phase,
    entry: r.entry,
    isDraft: r.is_draft,
    isOverride: r.is_override,
    createdAt: r.created_at,
  }
}

function mapADR(r: CodeDecisionDoc): ADR {
  return {
    id: r.id,
    taskId: r.task_id,
    title: r.title,
    context: r.context,
    options: r.options,
    decision: r.decision,
    consequences: r.consequences,
    status: r.status,
    createdAt: r.created_at,
  }
}

function mapSnapshot(r: CodeFileSnapshotDoc): FileSnapshot {
  return {
    id: Number(r.id),
    taskId: r.task_id,
    filePath: r.file_path,
    content: r.content,
    hash: r.hash,
    snapshotAt: r.snapshot_at,
  }
}

export class Scribe {
  private queue = Promise.resolve()
  private sessions = new Map<string, CodeSessionDoc>()
  private turns = new Map<string, CodeTurnDoc>()
  private tasks = new Map<string, CodeTaskDoc>()
  private phases = new Map<number, CodeTaskPhaseDoc>()
  private narrative: CodeNarrativeDoc[] = []
  private decisions: CodeDecisionDoc[] = []
  private snapshots: CodeFileSnapshotDoc[] = []
  private recoveryPoints: CodeRecoveryPointDoc[] = []
  private failures: LearningFailureDoc[] = []

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work, work).catch((err) => {
      log.warn("[scribe] HiveDB persistence failed:", (err as Error).message)
    })
  }

  private put<T>(collection: string, id: string, doc: T): void {
    this.enqueue(async () => {
      const docs = await col<T>(collection)
      const existing = await docs.get(id)
      await docs.put(id, doc, { expectedVersion: existing?.version ?? 0 })
    })
  }

  private delete<T>(collection: string, id: string): void {
    this.enqueue(async () => {
      await (await col<T>(collection)).delete(id)
    })
  }

  /** Await all queued durable writes — for graceful shutdown and tests. */
  async flush(): Promise<void> {
    await this.queue
  }

  private hydrated = false

  /**
   * Load durable state from HiveDB into the in-memory caches. Without this, a
   * fresh process starts with empty caches, so every read method below
   * (recovery points, snapshots, narrative, failure patterns) returns nothing
   * even though the data was persisted — the root cause that silently defeated
   * crash recovery. Idempotent; call once at manager boot before any task runs.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return
    this.hydrated = true
    try {
      const load = async <T>(collection: string): Promise<T[]> =>
        (await (await col<T>(collection)).scan()).map((entry) => entry.doc)

      for (const doc of await load<CodeSessionDoc>("codeSessions")) this.sessions.set(doc.id, doc)
      for (const doc of await load<CodeTurnDoc>("codeTurns")) this.turns.set(doc.id, doc)
      for (const doc of await load<CodeTaskDoc>("codeTasks")) this.tasks.set(doc.id, doc)
      for (const doc of await load<CodeTaskPhaseDoc>("codeTaskPhases")) this.phases.set(Number(doc.id), doc)
      this.narrative = await load<CodeNarrativeDoc>("codeNarrative")
      this.decisions = await load<CodeDecisionDoc>("codeDecisions")
      this.snapshots = await load<CodeFileSnapshotDoc>("codeFileSnapshots")
      this.recoveryPoints = await load<CodeRecoveryPointDoc>("codeRecoveryPoints")
      this.failures = await load<LearningFailureDoc>("learningFailures")
      log.info(
        `[scribe] Hydrated from HiveDB: ${this.recoveryPoints.length} recovery points, ` +
        `${this.tasks.size} tasks, ${this.narrative.length} narrative entries`,
      )
    } catch (err) {
      log.warn("[scribe] Hydration failed:", (err as Error).message)
    }
  }

  /** Tasks left in a non-terminal state by a previous process — resume candidates. */
  findInterruptedTasks(): CodeTaskDoc[] {
    return [...this.tasks.values()].filter(
      (task) => task.status === "running" || task.status === "planning" || task.status === "pending",
    )
  }

  createSession(projectPath: string): string {
    const id = Bun.randomUUIDv7()
    const doc: CodeSessionDoc = {
      id,
      project_path: projectPath,
      status: "active",
      created_at: nowIso(),
      last_active: nowIso(),
    }
    this.sessions.set(id, doc)
    this.put("codeSessions", id, doc)
    log.info(`[scribe] Session created: ${id} (${projectPath})`)
    return id
  }

  closeSession(sessionId: string): void {
    const doc = this.sessions.get(sessionId)
    if (doc) {
      const updated: CodeSessionDoc = { ...doc, status: "closed", last_active: nowIso() }
      this.sessions.set(sessionId, updated)
      this.put("codeSessions", sessionId, updated)
    }
    log.info(`[scribe] Session closed: ${sessionId}`)
  }

  createTurn(sessionId: string, userMessage: string): string {
    const id = Bun.randomUUIDv7()
    const doc: CodeTurnDoc = {
      id,
      session_id: sessionId,
      task_id: null,
      user_message: userMessage,
      agent_response: "",
      created_at: nowIso(),
      completed_at: null,
    }
    this.turns.set(id, doc)
    this.put("codeTurns", id, doc)
    return id
  }

  completeTurn(turnId: string, agentResponse: string, taskId?: string | null): void {
    const existing = this.turns.get(turnId)
    if (!existing) return
    const updated: CodeTurnDoc = {
      ...existing,
      agent_response: agentResponse,
      task_id: taskId ?? null,
      completed_at: nowIso(),
    }
    this.turns.set(turnId, updated)
    this.put("codeTurns", turnId, updated)
  }

  getRecentTurns(sessionId: string, limit = 10): Turn[] {
    return [...this.turns.values()]
      .filter((turn) => turn.session_id === sessionId && turn.completed_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .reverse()
      .map((turn) => ({
        id: turn.id,
        sessionId: turn.session_id,
        taskId: turn.task_id,
        userMessage: turn.user_message,
        agentResponse: turn.agent_response,
        createdAt: turn.created_at,
        completedAt: turn.completed_at,
      }))
  }

  createTask(sessionId: string, description: string, mode: string): string {
    const id = Bun.randomUUIDv7()
    const doc: CodeTaskDoc = {
      id,
      session_id: sessionId,
      description,
      status: "pending",
      mode: mode as CodeTaskDoc["mode"],
      branch_name: null,
      pr_url: null,
      tokens_in: 0,
      tokens_out: 0,
      files_changed: 0,
      lines_added: 0,
      lines_removed: 0,
      duration_ms: 0,
      created_at: nowIso(),
      completed_at: null,
    }
    this.tasks.set(id, doc)
    this.put("codeTasks", id, doc)
    log.info(`[scribe] Task created: ${id} - ${description.slice(0, 60)}`)
    return id
  }

  updateTaskStatus(taskId: string, status: string, extra?: { branchName?: string; prUrl?: string }): void {
    const existing = this.tasks.get(taskId)
    if (!existing) return
    const terminal = status === "completed" || status === "failed" || status === "cancelled"
    const updated: CodeTaskDoc = {
      ...existing,
      status: status as CodeTaskDoc["status"],
      branch_name: extra?.branchName ?? existing.branch_name,
      pr_url: extra?.prUrl ?? existing.pr_url,
      completed_at: terminal ? nowIso() : null,
    }
    this.tasks.set(taskId, updated)
    this.put("codeTasks", taskId, updated)
  }

  createPhase(taskId: string, phaseName: string, coordinator: string): number {
    const id = nextNumericId()
    const doc: CodeTaskPhaseDoc = {
      id: String(id),
      task_id: taskId,
      phase_name: phaseName,
      coordinator,
      status: "pending",
      result_summary: null,
      approved_at: null,
      approved_by: "auto",
      tokens_in: 0,
      tokens_out: 0,
      duration_ms: 0,
      started_at: null,
      completed_at: null,
    }
    this.phases.set(id, doc)
    this.put("codeTaskPhases", doc.id, doc)
    return id
  }

  updatePhaseStatus(phaseId: number, status: string, resultSummary?: string): void {
    const existing = this.phases.get(phaseId)
    if (!existing) return
    const updated: CodeTaskPhaseDoc = {
      ...existing,
      status: status as CodeTaskPhaseDoc["status"],
      result_summary: resultSummary ?? existing.result_summary,
      started_at: status === "running" ? nowIso() : existing.started_at,
      completed_at: status === "completed" || status === "failed" ? nowIso() : existing.completed_at,
    }
    this.phases.set(phaseId, updated)
    this.put("codeTaskPhases", updated.id, updated)
  }

  logModeChange(sessionId: string, mode: string, taskId?: string, phaseName?: string): void {
    const id = Bun.randomUUIDv7()
    const doc: CodeSessionModeDoc = {
      id,
      session_id: sessionId,
      task_id: taskId ?? null,
      mode: mode as CodeSessionModeDoc["mode"],
      changed_at: nowIso(),
      phase_at_change: phaseName ?? null,
      triggered_by: "cli",
    }
    this.put("codeSessionModes", id, doc)
  }

  appendNarrative(entry: NarrativeEntry): number {
    const numericId = nextNumericId()
    const doc: CodeNarrativeDoc = {
      id: String(numericId),
      task_id: entry.taskId,
      session_id: entry.sessionId,
      coordinator: entry.coordinator,
      phase: entry.phase || null,
      entry: entry.entry,
      is_draft: entry.isDraft,
      is_override: entry.isOverride,
      created_at: nowIso(),
    }
    this.narrative.push(doc)
    this.put("codeNarrative", doc.id, doc)
    return numericId
  }

  readNarrative(taskId?: string, lastN = 50): NarrativeEntry[] {
    return this.narrative
      .filter((entry) => !taskId || entry.task_id === taskId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, lastN)
      .reverse()
      .map(mapEntry)
  }

  searchNarrative(query: string): NarrativeEntry[] {
    const needle = query.toLowerCase()
    return this.narrative
      .filter((entry) =>
        entry.entry.toLowerCase().includes(needle) ||
        entry.coordinator.toLowerCase().includes(needle) ||
        (entry.phase ?? "").toLowerCase().includes(needle)
      )
      .slice(0, 20)
      .map(mapEntry)
  }

  writeDecision(adr: ADR): void {
    const doc: CodeDecisionDoc = {
      id: adr.id,
      task_id: adr.taskId,
      title: adr.title,
      context: adr.context,
      options: adr.options,
      decision: adr.decision,
      consequences: adr.consequences,
      status: adr.status,
      created_at: adr.createdAt ?? nowIso(),
    }
    this.decisions.push(doc)
    this.put("codeDecisions", doc.id, doc)
  }

  readDecisions(status?: string): ADR[] {
    return this.decisions
      .filter((decision) => !status || decision.status === status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(mapADR)
  }

  saveSnapshot(taskId: string, filePath: string, content: string, hash: string): void {
    const id = String(nextNumericId())
    const doc: CodeFileSnapshotDoc = {
      id,
      task_id: taskId,
      file_path: filePath,
      content,
      hash,
      snapshot_at: nowIso(),
    }
    this.snapshots.push(doc)
    this.put("codeFileSnapshots", id, doc)
  }

  getSnapshots(taskId: string): FileSnapshot[] {
    return this.snapshots
      .filter((snapshot) => snapshot.task_id === taskId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(mapSnapshot)
  }

  deleteSnapshots(taskId: string): void {
    const deleted = this.snapshots.filter((snapshot) => snapshot.task_id === taskId)
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.task_id !== taskId)
    for (const snapshot of deleted) this.delete<CodeFileSnapshotDoc>("codeFileSnapshots", snapshot.id)
  }

  saveRecoveryPoint(taskId: string, phaseId: number | null, completedPhases: number[], pendingPhases: number[], level = 0): void {
    let gitRef: string | null = null
    try {
      const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: process.cwd() })
      if (proc.exitCode === 0) gitRef = proc.stdout.toString().trim()
    } catch { /* no git repo */ }

    const lastNarrative = this.narrative
      .filter((entry) => entry.task_id === taskId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    const id = String(nextNumericId())
    const doc: CodeRecoveryPointDoc = {
      id,
      task_id: taskId,
      phase_id: phaseId == null ? null : String(phaseId),
      level,
      git_ref: gitRef,
      completed_phases: JSON.stringify(completedPhases),
      pending_phases: JSON.stringify(pendingPhases),
      last_narrative_id: lastNarrative?.id ?? null,
      created_at: nowIso(),
    }
    this.recoveryPoints.push(doc)
    this.put("codeRecoveryPoints", id, doc)
  }

  /** Persist the dependency-ordered plan a task is executing, so it can be resumed. */
  savePlan(taskId: string, plan: {
    phases: unknown[]
    description: string
    provider: string
    model: string
    archNarrative: string | null
    interfaces: string | null
    mode: string
  }): void {
    const doc: CodeTaskPlanDoc = {
      id: taskId,
      task_id: taskId,
      phases_json: JSON.stringify(plan.phases),
      description: plan.description,
      provider: plan.provider,
      model: plan.model,
      arch_narrative: plan.archNarrative,
      interfaces: plan.interfaces,
      mode: plan.mode,
      created_at: nowIso(),
    }
    this.put("codeTaskPlans", taskId, doc)
  }

  /** Read a task's persisted plan (resume path; reads HiveDB directly). */
  async getPlan(taskId: string): Promise<CodeTaskPlanDoc | null> {
    return (await (await col<CodeTaskPlanDoc>("codeTaskPlans")).get(taskId))?.doc ?? null
  }

  getLatestRecoveryPoint(taskId: string): {
    id: number; taskId: string; phaseId: number | null; level: number; gitRef: string | null;
    completedPhases: number[]; pendingPhases: number[]; lastNarrativeId: number | null; createdAt: string;
  } | null {
    const row = this.recoveryPoints
      .filter((point) => point.task_id === taskId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    if (!row) return null
    return {
      id: Number(row.id),
      taskId: row.task_id,
      phaseId: row.phase_id == null ? null : Number(row.phase_id),
      level: row.level,
      gitRef: row.git_ref,
      completedPhases: JSON.parse(row.completed_phases || "[]"),
      pendingPhases: JSON.parse(row.pending_phases || "[]"),
      lastNarrativeId: row.last_narrative_id == null ? null : Number(row.last_narrative_id),
      createdAt: row.created_at,
    }
  }

  getTaskContext(taskId: string): { narrative: NarrativeEntry[]; decisions: ADR[]; files: FileSnapshot[] } {
    return {
      narrative: this.readNarrative(taskId),
      decisions: this.readDecisions().filter(d => d.taskId === taskId),
      files: this.getSnapshots(taskId),
    }
  }

  updatePhaseMetadata(phaseId: number, tokensIn: number, tokensOut: number, durationMs: number): void {
    const existing = this.phases.get(phaseId)
    if (!existing) return
    const updated: CodeTaskPhaseDoc = {
      ...existing,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      duration_ms: durationMs,
    }
    this.phases.set(phaseId, updated)
    this.put("codeTaskPhases", updated.id, updated)
  }

  updateTaskMetadata(taskId: string, meta: TaskMetadata): void {
    const existing = this.tasks.get(taskId)
    if (!existing) return
    const updated: CodeTaskDoc = {
      ...existing,
      tokens_in: existing.tokens_in + meta.tokensIn,
      tokens_out: existing.tokens_out + meta.tokensOut,
      files_changed: meta.filesChanged,
      lines_added: meta.linesAdded,
      lines_removed: meta.linesRemoved,
      duration_ms: existing.duration_ms + meta.durationMs,
    }
    this.tasks.set(taskId, updated)
    this.put("codeTasks", taskId, updated)
  }

  writeFileChanges(taskId: string, phaseId: number | null, changes: FileChange[]): void {
    for (const change of changes) {
      const id = String(nextNumericId())
      const doc: CodeFileChangeDoc = {
        id,
        task_id: taskId,
        phase_id: phaseId == null ? null : String(phaseId),
        file_path: change.filePath,
        change_type: change.changeType,
        lines_added: change.linesAdded,
        lines_removed: change.linesRemoved,
        created_at: nowIso(),
      }
      this.put("codeFileChanges", id, doc)
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
    const id = String(nextNumericId())
    const doc: CodeTraceDoc = {
      id,
      task_id: trace.taskId,
      agent_id: trace.agentId,
      coordinator: trace.coordinator,
      tool_name: trace.toolName,
      input_summary: trace.inputSummary ?? "",
      output_summary: trace.outputSummary ?? "",
      success: trace.success,
      duration_ns: trace.durationNs ?? 0,
      tokens_in: trace.tokensIn ?? 0,
      tokens_out: trace.tokensOut ?? 0,
      analyzed: false,
      created_at: nowIso(),
    }
    this.put("codeTraces", id, doc)
  }

  writeFailure(f: {
    taskId: string
    phaseId: string | null
    agent: string
    failureType: "tool_error" | "phase_failure" | "invalid_output" | "plan_drift" | "timeout"
    errorMessage: string
    contextSummary?: string
  }): void {
    const id = String(nextNumericId())
    const doc: LearningFailureDoc = {
      id,
      task_id: f.taskId,
      phase_id: f.phaseId,
      agent: f.agent,
      failure_type: f.failureType,
      error_message: f.errorMessage,
      context_summary: f.contextSummary ?? null,
      resolved: false,
      resolution: null,
      created_at: nowIso(),
    }
    this.failures.push(doc)
    this.put("learningFailures", id, doc)
  }

  writeProposal(p: {
    sourceAgent: string
    proposalType: "skill_adjust" | "new_skill" | "prompt_change" | "phase_order" | "escalate_to_human"
    description: string
    failureIds: number[]
  }): void {
    const id = String(nextNumericId())
    const doc: LearningProposalDoc = {
      id,
      source_agent: p.sourceAgent,
      proposal_type: p.proposalType,
      description: p.description,
      failure_ids: JSON.stringify(p.failureIds),
      status: "pending",
      created_at: nowIso(),
    }
    this.put("learningProposals", id, doc)
  }

  getFailurePatterns(opts?: { minOccurrences?: number }): Array<{
    agent: string
    failureType: string
    count: number
    ids: number[]
    lastSeen: string
  }> {
    const min = opts?.minOccurrences ?? 1
    const grouped = new Map<string, LearningFailureDoc[]>()
    for (const failure of this.failures.filter((entry) => !entry.resolved)) {
      const key = `${failure.agent}:${failure.failure_type}`
      grouped.set(key, [...(grouped.get(key) ?? []), failure])
    }
    return [...grouped.entries()]
      .map(([key, rows]) => {
        const [agent, failureType] = key.split(":")
        return {
          agent,
          failureType,
          count: rows.length,
          ids: rows.map((row) => Number(row.id)),
          lastSeen: rows.sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.created_at ?? "",
        }
      })
      .filter((entry) => entry.count >= min)
      .sort((a, b) => b.count - a.count)
  }

  evaluateTaskPhases(taskId: string): {
    hasFailures: boolean
    frictionPhase: string | null
    failureSummary: string
  } {
    const grouped = new Map<string, number>()
    for (const failure of this.failures.filter((entry) => entry.task_id === taskId)) {
      const key = `${failure.agent}/${failure.failure_type}`
      grouped.set(key, (grouped.get(key) ?? 0) + 1)
    }
    if (grouped.size === 0) {
      return { hasFailures: false, frictionPhase: null, failureSummary: "" }
    }
    const entries = [...grouped.entries()].sort((a, b) => b[1] - a[1])
    const [agent] = entries[0][0].split("/")
    return {
      hasFailures: true,
      frictionPhase: agent,
      failureSummary: entries.map(([key, count]) => `${key}(x${count})`).join(", "),
    }
  }
}
