import { col } from "@johpaz/hivecode-core/storage/hive"
import type { AgentConflictDoc, FileRiskDoc } from "@johpaz/hivecode-core/storage/collections"
import type { Blackboard } from "./blackboard.ts"
import type { IpcEmitter } from "./ipc-emitter.ts"

export type ConflictSeverity = "low" | "medium" | "high" | "critical"

export interface Conflict {
  type: "file_collision" | "decision_clash" | "adr_violation" | "dependency_race"
  agentA: string
  agentB: string
  filePath?: string
  description: string
  severity: ConflictSeverity
  contextId?: string
}

export class ConflictDetector {
  private conflictCache: AgentConflictDoc[] = []

  constructor(
    _db: unknown,
    private sessionId: string,
    private blackboard: Blackboard,
    private ipc: IpcEmitter,
  ) {}

  /** Llamar ANTES de que un worker escriba un archivo */
  async checkBeforeWrite(agent: string, filePath: string): Promise<Conflict[]> {
    const found: Conflict[] = []
    const now = Date.now()
    const windowStart = now - 30_000

    const risks = await col<FileRiskDoc>("fileRisks")
    const others = (await risks.findBy("session_id", this.sessionId))
      .map(entry => entry.doc)
      .filter(r => r.file_path === filePath && r.agent !== agent && r.updated_at > windowStart)

    for (const other of others) {
      found.push({
        type: "file_collision",
        agentA: agent,
        agentB: other.agent ?? "unknown",
        filePath,
        description: `${agent} y ${other.agent} quieren modificar ${filePath} simultaneamente`,
        severity: "high",
      })
    }

    const constraints = this.blackboard.getConstraints(filePath)
    for (const c of constraints) {
      found.push({
        type: "adr_violation",
        agentA: agent,
        agentB: "bee",
        filePath,
        description: `${agent} quiere modificar ${filePath} pero existe un constraint: "${c.content.slice(0, 100)}"`,
        severity: "critical",
        contextId: c.id,
      })
    }

    const conflicts = await col<AgentConflictDoc>("agentConflicts")
    for (const c of found) {
      const id = `conflict_${now}_${Math.random().toString(16).slice(2, 8)}`
      const doc: AgentConflictDoc = {
        id,
        session_id: this.sessionId,
        agent_a: c.agentA,
        agent_b: c.agentB,
        type: c.type,
        description: c.description,
        file_path: c.filePath ?? null,
        context_id_a: c.contextId ?? null,
        context_id_b: null,
        severity: c.severity,
        resolved: false,
        resolved_by: null,
        resolution: null,
        created_at: Date.now(),
        resolved_at: null,
      }
      this.conflictCache.push(doc)
      await conflicts.put(id, doc)

      this.ipc.emit("conflict_detected", {
        agent_a: c.agentA,
        agent_b: c.agentB,
        severity: c.severity,
        description: c.description,
        file_path: c.filePath ?? null,
      })
    }

    return found
  }

  listUnresolved(): AgentConflictDoc[] {
    return this.conflictCache
      .filter(entry => !entry.resolved)
      .sort((a, b) => b.created_at - a.created_at)
  }

  resolve(id: string, resolvedBy: "bee" | "human", resolution: string): void {
    this.conflictCache = this.conflictCache.map(entry =>
      entry.id === id
        ? { ...entry, resolved: true, resolved_by: resolvedBy, resolution, resolved_at: Date.now() }
        : entry,
    )
    void this.persistResolution(id, resolvedBy, resolution)
    this.ipc.emit("conflict_resolved", { conflict_id: id, resolution })
  }

  private async persistResolution(id: string, resolvedBy: "bee" | "human", resolution: string): Promise<void> {
    const conflicts = await col<AgentConflictDoc>("agentConflicts")
    const existing = await conflicts.get(id)
    if (!existing) return
    await conflicts.put(
      id,
      {
        ...existing.doc,
        resolved: true,
        resolved_by: resolvedBy,
        resolution,
        resolved_at: Date.now(),
      },
      { expectedVersion: existing.version },
    )
  }
}
