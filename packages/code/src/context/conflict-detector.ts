import type { Database } from "bun:sqlite"
import { AgentConflictsRepo, FileRisksRepo, type ConflictSeverity } from "@johpaz/hivecode-core/db"
import type { Blackboard } from "./blackboard.ts"
import type { IpcEmitter } from "./ipc-emitter.ts"

export interface Conflict {
  type: "file_collision" | "decision_clash" | "adr_violation" | "dependency_race"
  agentA: string
  agentB: string
  filePath?: string
  description: string
  severity: ConflictSeverity
  contextId?: number
}

export class ConflictDetector {
  private conflicts: AgentConflictsRepo
  private fileRisks: FileRisksRepo

  // Bug-A fix: ipc agregado al constructor
  constructor(
    private db: Database,
    private sessionId: string,
    private blackboard: Blackboard,
    private ipc: IpcEmitter,
  ) {
    this.conflicts = new AgentConflictsRepo(db)
    this.fileRisks = new FileRisksRepo(db)
  }

  /** Llamar ANTES de que un worker escriba un archivo */
  async checkBeforeWrite(agent: string, filePath: string): Promise<Conflict[]> {
    const found: Conflict[] = []

    // 1. ¿Otro worker tocó este archivo en los últimos 30s?
    const recentRisks = this.fileRisks.getByAgent(this.sessionId, agent, Date.now() - 30_000)
    const others = this.fileRisks
      .listBySession(this.sessionId)
      .filter(r => r.file_path === filePath && r.agent !== agent && r.updated_at > Date.now() - 30_000)

    for (const other of others) {
      found.push({
        type: "file_collision",
        agentA: agent,
        agentB: other.agent ?? "unknown",
        filePath,
        description: `${agent} y ${other.agent} quieren modificar ${filePath} simultáneamente`,
        severity: "high",
      })
    }

    // 2. ¿Existe un constraint activo para este archivo?
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

    // Persistir y emitir conflictos
    for (const c of found) {
      this.conflicts.create({
        sessionId: this.sessionId,
        agentA: c.agentA,
        agentB: c.agentB,
        type: c.type,
        description: c.description,
        filePath: c.filePath,
        severity: c.severity,
        contextIdA: c.contextId,
      })

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

  listUnresolved(): ReturnType<AgentConflictsRepo["listUnresolved"]> {
    return this.conflicts.listUnresolved(this.sessionId)
  }

  resolve(id: number, resolvedBy: "bee" | "human", resolution: string): void {
    this.conflicts.resolve(id, resolvedBy, resolution)
    this.ipc.emit("conflict_resolved", { conflict_id: id, resolution })
  }
}
