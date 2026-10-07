import { col, updateDoc } from "@johpaz/hivecode-core/storage/hive"
import { getHiveDbPath } from "@johpaz/hivecode-core/storage/hivedb"
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

/**
 * Length cap of the provisional session title stamped by `createTurn`.
 *
 * The background namer (see session-titles.ts) recognises a still-provisional
 * title by comparing against `userMessage.slice(0, this)`, so the two must
 * share one constant — a mismatch would make the namer skip forever.
 */
export const PROVISIONAL_TITLE_LIMIT = 120

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

  /**
   * Secondary indexes every indexed read below depends on. `createIndex` is
   * idempotent (bootstrap.ts calls it on every boot), so this is safe to run
   * against an already-bootstrapped database. Done here rather than assumed from
   * `ensureHiveDb()` so a Scribe works regardless of bootstrap ordering, and so
   * an indexed read fails loudly on a missing index instead of silently
   * returning an empty result.
   */
  private static readonly REQUIRED_INDEXES: ReadonlyArray<readonly [string, string]> = [
    ["codeTasks", "status"],
    ["codeTasks", "session_id"],
    ["codeTurns", "session_id"],
    ["codeNarrative", "task_id"],
    ["codeDecisions", "status"],
    ["codeDecisions", "task_id"],
    ["codeFileSnapshots", "task_id"],
    ["codeRecoveryPoints", "task_id"],
    ["learningFailures", "task_id"],
    ["learningFailures", "resolved"],
  ]

  private static indexesReady: Promise<void> | null = null
  private static indexesPath: string | null = null

  private static ensureIndexes(): Promise<void> {
    // Keyed by resolved DB path: a test (or a caller) can repoint HIVE_DB_PATH at a
    // fresh database, and the memo must not claim indexes exist on the new one.
    const path = getHiveDbPath()
    if (Scribe.indexesReady && Scribe.indexesPath === path) return Scribe.indexesReady
    Scribe.indexesPath = path
    Scribe.indexesReady = (async () => {
      for (const [collection, field] of Scribe.REQUIRED_INDEXES) {
        await (await col(collection)).createIndex(field)
      }
    })().catch((err) => {
      // Let the next call retry rather than caching a rejected promise forever.
      Scribe.indexesReady = null
      Scribe.indexesPath = null
      throw err
    })
    return Scribe.indexesReady
  }

  /** Read every doc in a collection — only for the rare query no index covers. */
  private static async loadAll<T>(collection: string): Promise<T[]> {
    await Scribe.ensureIndexes()
    return (await (await col<T>(collection)).scan()).map((entry) => entry.doc)
  }

  private static async loadBy<T>(collection: string, field: string, value: string | number | boolean): Promise<T[]> {
    await Scribe.ensureIndexes()
    return (await (await col<T>(collection)).findBy(field, value)).map((entry) => entry.doc)
  }

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

  /**
   * Read-then-patch a single doc, retrying on version conflict. No-ops when the
   * doc is absent, matching the old cache behaviour where a miss was silent.
   * Every mutation goes through here instead of an in-memory copy, so a write
   * from another process is merged instead of being reverted by a stale snapshot.
   */
  private patch<T extends object>(collection: string, id: string, patch: Partial<T>): void {
    this.enqueue(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await (await col<T>(collection)).get(id)
        if (!existing) return
        try {
          await (await col<T>(collection)).put(id, { ...existing.doc, ...patch }, { expectedVersion: existing.version })
          return
        } catch {
          // Version conflict — re-read and retry.
        }
      }
      log.warn(`[scribe] ${collection}/${id}: too much contention, patch dropped`)
    })
  }

  /** Await all queued durable writes — for graceful shutdown and tests. */
  async flush(): Promise<void> {
    await this.queue
  }

  /**
   * Tasks left in a non-terminal state by a previous process — resume candidates.
   * Hits the `codeTasks.status` index once per non-terminal status instead of
   * scanning the whole collection, so cost is bounded by what needs resuming.
   */
  async findInterruptedTasks(): Promise<CodeTaskDoc[]> {
    const found: CodeTaskDoc[] = []
    for (const status of ["running", "planning", "pending"]) {
      found.push(...await Scribe.loadBy<CodeTaskDoc>("codeTasks", "status", status))
    }
    return found
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
    this.put("codeSessions", id, doc)
    log.info(`[scribe] Session created: ${id} (${projectPath})`)
    return id
  }

  closeSession(sessionId: string): void {
    this.patch<CodeSessionDoc>("codeSessions", sessionId, { status: "closed", last_active: nowIso() })
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
    this.put("codeTurns", id, doc)
    // A session's name is its user's request. The first turn stamps a
    // provisional title so the session is never nameless in the picker, even
    // if the background LLM renamer never runs or fails.
    this.enqueue(async () => {
      const sessions = await col<CodeSessionDoc>("codeSessions")
      const existing = await sessions.get(sessionId)
      if (!existing || existing.doc.title) return
      await updateDoc<CodeSessionDoc>("codeSessions", sessionId, {
        title: userMessage.slice(0, PROVISIONAL_TITLE_LIMIT),
      })
    })
    return id
  }

  completeTurn(turnId: string, agentResponse: string, taskId?: string | null): void {
    this.patch<CodeTurnDoc>("codeTurns", turnId, {
      agent_response: agentResponse,
      task_id: taskId ?? null,
      completed_at: nowIso(),
    })
    // Bump the session so the picker sorts by real activity, not creation time.
    this.enqueue(async () => {
      const turn = await (await col<CodeTurnDoc>("codeTurns")).get(turnId)
      if (!turn) return
      const sessions = await col<CodeSessionDoc>("codeSessions")
      if (!(await sessions.get(turn.doc.session_id))) return
      await updateDoc<CodeSessionDoc>("codeSessions", turn.doc.session_id, { last_active: nowIso() })
    })
  }

  async getRecentTurns(sessionId: string, limit = 10): Promise<Turn[]> {
    return (await Scribe.loadBy<CodeTurnDoc>("codeTurns", "session_id", sessionId))
      .filter((turn) => turn.completed_at)
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
    this.put("codeTasks", id, doc)
    log.info(`[scribe] Task created: ${id} - ${description.slice(0, 60)}`)
    return id
  }

  updateTaskStatus(taskId: string, status: string, extra?: { branchName?: string; prUrl?: string }): void {
    const terminal = status === "completed" || status === "failed" || status === "cancelled"
    // Only include the optional fields when supplied — an absent key in the patch
    // preserves whatever the stored doc already has.
    this.patch<CodeTaskDoc>("codeTasks", taskId, {
      status: status as CodeTaskDoc["status"],
      completed_at: terminal ? nowIso() : null,
      ...(extra?.branchName !== undefined && { branch_name: extra.branchName }),
      ...(extra?.prUrl !== undefined && { pr_url: extra.prUrl }),
    })
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
    this.put("codeTaskPhases", doc.id, doc)
    return id
  }

  updatePhaseStatus(phaseId: number, status: string, resultSummary?: string): void {
    const terminal = status === "completed" || status === "failed"
    // `started_at` is set once on the transition into running; every other field
    // keeps its stored value unless this call supplies a new one.
    this.patch<CodeTaskPhaseDoc>("codeTaskPhases", String(phaseId), {
      status: status as CodeTaskPhaseDoc["status"],
      ...(resultSummary !== undefined && { result_summary: resultSummary }),
      ...(status === "running" && { started_at: nowIso() }),
      ...(terminal && { completed_at: nowIso() }),
    })
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
    this.put("codeNarrative", doc.id, doc)
    return numericId
  }

  /**
   * Read narrative entries, newest-last. Uses the `codeNarrative.task_id` index
   * when a task is given; the unfiltered form is a bounded scan and is expected
   * to be rare.
   */
  async readNarrative(taskId?: string, lastN = 50): Promise<NarrativeEntry[]> {
    const docs = taskId
      ? await Scribe.loadBy<CodeNarrativeDoc>("codeNarrative", "task_id", taskId)
      : await Scribe.loadAll<CodeNarrativeDoc>("codeNarrative")
    return docs
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, lastN)
      .reverse()
      .map(mapEntry)
  }

  /** Full-text search over narrative — no index covers this, so it scans. */
  async searchNarrative(query: string): Promise<NarrativeEntry[]> {
    const needle = query.toLowerCase()
    return (await Scribe.loadAll<CodeNarrativeDoc>("codeNarrative"))
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
    this.put("codeDecisions", doc.id, doc)
  }

  /** Uses the `codeDecisions.status` index when a status filter is given. */
  async readDecisions(status?: string): Promise<ADR[]> {
    const docs = status
      ? await Scribe.loadBy<CodeDecisionDoc>("codeDecisions", "status", status)
      : await Scribe.loadAll<CodeDecisionDoc>("codeDecisions")
    return docs
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
    this.put("codeFileSnapshots", id, doc)
  }

  async getSnapshots(taskId: string): Promise<FileSnapshot[]> {
    return (await Scribe.loadBy<CodeFileSnapshotDoc>("codeFileSnapshots", "task_id", taskId))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(mapSnapshot)
  }

  async deleteSnapshots(taskId: string): Promise<void> {
    const targets = await Scribe.loadBy<CodeFileSnapshotDoc>("codeFileSnapshots", "task_id", taskId)
    for (const snapshot of targets) {
      this.delete<CodeFileSnapshotDoc>("codeFileSnapshots", snapshot.id)
    }
  }

  async saveRecoveryPoint(taskId: string, phaseId: number | null, completedPhases: number[], pendingPhases: number[], level = 0): Promise<void> {
    let gitRef: string | null = null
    try {
      const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: process.cwd() })
      if (proc.exitCode === 0) gitRef = proc.stdout.toString().trim()
    } catch { /* no git repo */ }

    // The newest narrative entry is the story anchor the resume path rewinds to.
    // Drain the queue first: narrative writes are enqueued, so reading the index
    // now would miss entries this task just appended.
    await this.flush()
    const narrative = await Scribe.loadBy<CodeNarrativeDoc>("codeNarrative", "task_id", taskId)
    const lastNarrative = narrative.sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
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

  async getLatestRecoveryPoint(taskId: string): Promise<{
    id: number; taskId: string; phaseId: number | null; level: number; gitRef: string | null;
    completedPhases: number[]; pendingPhases: number[]; lastNarrativeId: number | null; createdAt: string;
  } | null> {
    const row = (await Scribe.loadBy<CodeRecoveryPointDoc>("codeRecoveryPoints", "task_id", taskId))
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

  async getTaskContext(taskId: string): Promise<{ narrative: NarrativeEntry[]; decisions: ADR[]; files: FileSnapshot[] }> {
    return {
      narrative: await this.readNarrative(taskId),
      decisions: (await this.readDecisions()).filter(d => d.taskId === taskId),
      files: await this.getSnapshots(taskId),
    }
  }

  updatePhaseMetadata(phaseId: number, tokensIn: number, tokensOut: number, durationMs: number): void {
    this.patch<CodeTaskPhaseDoc>("codeTaskPhases", String(phaseId), {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      duration_ms: durationMs,
    })
  }

  /**
   * Task token/duration counters are cumulative, so this must read the stored
   * values before adding. The read happens inside the serialized queue, so a
   * concurrent increment can't be lost — the retry in `patch` is not enough
   * because the patch body depends on the value just read.
   */
  updateTaskMetadata(taskId: string, meta: TaskMetadata): void {
    this.enqueue(async () => {
      const tasks = await col<CodeTaskDoc>("codeTasks")
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await tasks.get(taskId)
        if (!existing) return
        const updated: CodeTaskDoc = {
          ...existing.doc,
          tokens_in: existing.doc.tokens_in + meta.tokensIn,
          tokens_out: existing.doc.tokens_out + meta.tokensOut,
          files_changed: meta.filesChanged,
          lines_added: meta.linesAdded,
          lines_removed: meta.linesRemoved,
          duration_ms: existing.doc.duration_ms + meta.durationMs,
        }
        try {
          await tasks.put(taskId, updated, { expectedVersion: existing.version })
          return
        } catch {
          // Version conflict — re-read and re-accumulate.
        }
      }
      log.warn(`[scribe] codeTasks/${taskId}: too much contention, metadata not accumulated`)
    })
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

  async getFailurePatterns(opts?: { minOccurrences?: number }): Promise<Array<{
    agent: string
    failureType: string
    count: number
    ids: number[]
    lastSeen: string
  }>> {
    const min = opts?.minOccurrences ?? 1
    const grouped = new Map<string, LearningFailureDoc[]>()
    // Unresolved only — via the `learningFailures.resolved` index.
    for (const failure of await Scribe.loadBy<LearningFailureDoc>("learningFailures", "resolved", false)) {
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

  async evaluateTaskPhases(taskId: string): Promise<{
    hasFailures: boolean
    frictionPhase: string | null
    failureSummary: string
  }> {
    const grouped = new Map<string, number>()
    for (const failure of await Scribe.loadBy<LearningFailureDoc>("learningFailures", "task_id", taskId)) {
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
