import { col } from "@johpaz/hivecode-core/storage/hive"
import type { AgentAwarenessDoc, AgentContextDoc } from "@johpaz/hivecode-core/storage/collections"
import type { IpcEmitter } from "./ipc-emitter.ts"

export type ContextType = "decision" | "observation" | "constraint" | "question" | "reasoning" | string
export type ContextScope = "file" | "api" | "schema" | "task" | "global" | string
export type ContextEntry = AgentContextDoc
export type WorkerAwareness = AgentAwarenessDoc & { worker: string }

export class Blackboard {
  private contextCache: AgentContextDoc[] = []
  private awarenessCache: AgentAwarenessDoc[] = []

  constructor(
    _db: unknown,
    private sessionId: string,
    private ipc?: IpcEmitter,
  ) {}

  async write(
    agent: string,
    type: ContextType,
    content: string,
    options?: { filePath?: string; parentId?: string | number; scope?: ContextScope; traceSummary?: string },
  ): Promise<string> {
    const contexts = await col<AgentContextDoc>("agentContext")
    const id = `ctx_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    const now = Date.now()
    const doc: AgentContextDoc = {
      id,
      session_id: this.sessionId,
      agent,
      type,
      content,
      status: "active",
      scope: options?.scope ?? null,
      file_path: options?.filePath ?? null,
      parent_id: options?.parentId == null ? null : String(options.parentId),
      resolved_by: null,
      trace_summary: options?.traceSummary ?? null,
      created_at: now,
      updated_at: now,
    }

    this.contextCache.push(doc)
    await contexts.put(id, doc)

    this.ipc?.emit("context_update", {
      agent,
      context_type: type,
      content,
      file_path: options?.filePath,
    })

    if (agent !== "bee") {
      await this.upsertAwareness({
        session_id: this.sessionId,
        observer: "bee",
        observed: agent,
        phase: null,
        status: type === "observation" && content.includes("Completada") ? "done" : "running",
        last_known_action: content.slice(0, 120),
        last_known_file: options?.filePath ?? null,
        pending_question: null,
        confidence: 1,
        updated_at: now,
      })
    }

    return id
  }

  readRelevant(_agent: string, options?: { filePath?: string; query?: string }): ContextEntry[] {
    const query = options?.query?.toLowerCase()
    return this.contextCache
      .filter(entry => entry.status === "active")
      .filter(entry => !options?.filePath || entry.file_path === options.filePath || entry.file_path === null)
      .filter(entry => !query || entry.content.toLowerCase().includes(query) || entry.agent.toLowerCase().includes(query))
      .sort((a, b) => b.updated_at - a.updated_at)
  }

  supersede(id: string | number, replacedBy: string): void {
    const key = String(id)
    this.contextCache = this.contextCache.map(entry =>
      entry.id === key ? { ...entry, status: "superseded", resolved_by: replacedBy, updated_at: Date.now() } : entry,
    )
    void this.patchContext(key, { status: "superseded", resolved_by: replacedBy })
  }

  resolve(id: string | number, resolvedBy: string): void {
    const key = String(id)
    this.contextCache = this.contextCache.map(entry =>
      entry.id === key ? { ...entry, status: "resolved", resolved_by: resolvedBy, updated_at: Date.now() } : entry,
    )
    void this.patchContext(key, { status: "resolved", resolved_by: resolvedBy })
  }

  beeAwareness(): WorkerAwareness[] {
    return this.awarenessCache
      .filter(entry => entry.observer === "bee")
      .map(entry => ({ ...entry, worker: entry.observed }))
      .sort((a, b) => b.updated_at - a.updated_at)
  }

  async askWorker(from: string, to: string, question: string): Promise<string> {
    const id = await this.write(from, "question", question)
    await this.patchAwareness(to, { pending_question: id })
    return id
  }

  getConstraints(filePath: string): ContextEntry[] {
    return this.contextCache
      .filter(entry => entry.status === "active")
      .filter(entry => entry.type === "constraint")
      .filter(entry => !entry.file_path || entry.file_path === filePath || filePath.startsWith(entry.file_path))
      .sort((a, b) => b.updated_at - a.updated_at)
  }

  updateWorkerStatus(
    worker: string,
    status: "waiting" | "running" | "done" | "failed",
    phase?: string,
    currentFile?: string,
  ): void {
    void this.upsertAwareness({
      session_id: this.sessionId,
      observer: "bee",
      observed: worker,
      phase: phase ?? null,
      status,
      last_known_action: null,
      last_known_file: currentFile ?? null,
      pending_question: null,
      confidence: 1,
      updated_at: Date.now(),
    })
  }

  decayConfidence(): void {
    this.awarenessCache = this.awarenessCache.map(entry =>
      entry.observer === "bee"
        ? { ...entry, confidence: Math.max(0, entry.confidence * 0.95), updated_at: Date.now() }
        : entry,
    )
    void this.persistAwarenessCache()
  }

  private async persistAwarenessCache(): Promise<void> {
    const awareness = await col<AgentAwarenessDoc>("agentAwareness")
    for (const doc of this.awarenessCache) {
      const existing = await awareness.get(doc.id)
      await awareness.put(doc.id, doc, { expectedVersion: existing?.version ?? 0 })
    }
  }

  private async patchContext(id: string, patch: Partial<AgentContextDoc>): Promise<void> {
    const contexts = await col<AgentContextDoc>("agentContext")
    const existing = await contexts.get(id)
    if (!existing) return
    await contexts.put(id, { ...existing.doc, ...patch, updated_at: Date.now() }, { expectedVersion: existing.version })
  }

  private async patchAwareness(worker: string, patch: Partial<AgentAwarenessDoc>): Promise<void> {
    const awareness = await col<AgentAwarenessDoc>("agentAwareness")
    const id = `${this.sessionId}:bee:${worker}`
    const existing = await awareness.get(id)
    if (!existing) {
      await this.upsertAwareness({
        session_id: this.sessionId,
        observer: "bee",
        observed: worker,
        phase: null,
        status: "waiting",
        last_known_action: null,
        last_known_file: null,
        pending_question: null,
        confidence: 1,
        updated_at: Date.now(),
        ...patch,
      })
      return
    }
    await awareness.put(id, { ...existing.doc, ...patch, updated_at: Date.now() }, { expectedVersion: existing.version })
  }

  private async upsertAwareness(doc: Omit<AgentAwarenessDoc, "id">): Promise<void> {
    const awareness = await col<AgentAwarenessDoc>("agentAwareness")
    const id = `${doc.session_id}:${doc.observer}:${doc.observed}`
    const next = { id, ...doc }
    const index = this.awarenessCache.findIndex(entry => entry.id === id)
    if (index >= 0) {
      this.awarenessCache[index] = next
    } else {
      this.awarenessCache.push(next)
    }
    const existing = await awareness.get(id)
    await awareness.put(id, next, { expectedVersion: existing?.version ?? 0 })
  }
}
