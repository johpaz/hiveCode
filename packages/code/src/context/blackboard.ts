import type { Database } from "bun:sqlite"
import {
  AgentContextRepo,
  AgentAwarenessRepo,
  type ContextType,
  type ContextScope,
  type ContextEntry,
  type WorkerAwareness,
} from "@johpaz/hivecode-core/db"
import type { IpcEmitter } from "./ipc-emitter.ts"

export class Blackboard {
  private ctx: AgentContextRepo
  private awareness: AgentAwarenessRepo

  constructor(
    private db: Database,
    private sessionId: string,
    private ipc?: IpcEmitter,
  ) {
    this.ctx = new AgentContextRepo(db)
    this.awareness = new AgentAwarenessRepo(db)
  }

  async write(
    agent: string,
    type: ContextType,
    content: string,
    options?: { filePath?: string; parentId?: number; scope?: ContextScope },
  ): Promise<number> {
    const id = this.ctx.write(this.sessionId, agent, type, content, options)

    this.ipc?.emit("context_update", {
      agent,
      context_type: type,
      content,
      file_path: options?.filePath,
    })

    // Mantener awareness de Bee: actualizar last_known_action por agente
    if (agent !== "bee") {
      this.awareness.upsert({
        session_id: this.sessionId,
        observer: "bee",
        observed: agent,
        phase: null,
        status: type === "observation" && content.includes("Completada") ? "done" : "running",
        last_known_action: content.slice(0, 120),
        last_known_file: options?.filePath ?? null,
        pending_question: null,
        confidence: 1.0,
      })
    }

    return id
  }

  readRelevant(agent: string, options?: { filePath?: string; query?: string }): ContextEntry[] {
    return this.ctx.readRelevant(this.sessionId, options)
  }

  supersede(id: number, replacedBy: string): void {
    this.ctx.supersede(id, replacedBy)
  }

  resolve(id: number, resolvedBy: string): void {
    this.ctx.resolve(id, resolvedBy)
  }

  beeAwareness(): WorkerAwareness[] {
    return this.ctx.beeAwareness(this.sessionId)
  }

  /** Bee pregunta a un worker — crea question en el blackboard y marca pending */
  askWorker(from: string, to: string, question: string): Promise<number> {
    return Promise.resolve(
      (async () => {
        const id = await this.write(from, "question", question)
        this.awareness.setPendingQuestion(this.sessionId, to, id)
        return id
      })(),
    )
  }

  getConstraints(filePath: string): ContextEntry[] {
    return this.ctx.getConstraints(this.sessionId, filePath)
  }

  updateWorkerStatus(
    worker: string,
    status: "waiting" | "running" | "done" | "failed",
    phase?: string,
    currentFile?: string,
  ): void {
    this.awareness.upsert({
      session_id: this.sessionId,
      observer: "bee",
      observed: worker,
      phase: phase ?? null,
      status,
      last_known_action: null,
      last_known_file: currentFile ?? null,
      pending_question: null,
      confidence: 1.0,
    })
  }

  decayConfidence(): void {
    this.awareness.decayConfidence(this.sessionId)
  }
}
