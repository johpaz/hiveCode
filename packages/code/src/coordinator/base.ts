import type { Database } from "bun:sqlite"
import { Blackboard } from "../context/blackboard.ts"
import { ConflictDetector } from "../context/conflict-detector.ts"
import { CheckpointManager } from "../checkpoint/manager.ts"
import { AdrLoader } from "../adr/loader.ts"
import { RiskCalculator } from "../adr/risk.ts"
import type { IpcEmitter } from "../context/ipc-emitter.ts"

/**
 * Abstract base that owns the shared per-session subsystems:
 * Blackboard, ConflictDetector, CheckpointManager, AdrLoader, RiskCalculator.
 *
 * CoordinatorManager extends this so all subsystems are accessible in one place.
 */
export abstract class CoordinatorBase {
  protected blackboard!: Blackboard
  protected conflictDetector!: ConflictDetector
  protected checkpointManager!: CheckpointManager
  protected adrLoader!: AdrLoader
  protected riskCalculator!: RiskCalculator

  /**
   * Must be called once (in startAll) after a session ID is available.
   * Wires all subsystems to the per-session SQLite DB.
   */
  protected initSubsystems(
    db: Database,
    sessionId: string,
    ipc: IpcEmitter,
  ): void {
    this.blackboard        = new Blackboard(db, sessionId, ipc)
    this.conflictDetector  = new ConflictDetector(db, sessionId, this.blackboard, ipc)
    this.checkpointManager = new CheckpointManager(db, sessionId, ipc)
    this.adrLoader         = new AdrLoader(db)
    this.riskCalculator    = new RiskCalculator(db, sessionId, ipc)
  }

  /**
   * Load ADRs from the project's adrs/ directory.
   * Safe to call repeatedly — skips unchanged files.
   */
  protected loadProjectAdrs(projectPath: string): void {
    if (!this.adrLoader) return
    try {
      const result = this.adrLoader.load(projectPath)
      if (result.loaded > 0) {
        // side effect only — logs happen in AdrLoader
      }
    } catch {
      // ADRs are optional — never block startup
    }
  }

  /**
   * Evaluate file risk before or after a write operation and emit IPC update.
   */
  protected evaluateFileRisk(
    filePath: string,
    operation: "created" | "modified" | "deleted",
    agent: string,
  ): void {
    if (!this.riskCalculator) return
    try {
      this.riskCalculator.evaluate(filePath, operation, agent)
    } catch {
      // Risk evaluation is advisory — never block execution
    }
  }

  /**
   * Check for conflicts before writing a file.
   * Returns false if there is a blocking conflict.
   */
  protected async checkWriteConflicts(agent: string, filePath: string): Promise<boolean> {
    if (!this.conflictDetector) return true
    try {
      const conflicts = await this.conflictDetector.checkBeforeWrite(agent, filePath)
      return conflicts.length === 0
    } catch {
      return true
    }
  }

  /**
   * Create a checkpoint before mutating files.
   * Returns the checkpoint ID, or null on failure.
   */
  protected async checkpoint(
    description: string,
    existingPaths: string[],
    newPaths: string[] = [],
    agent = "bee",
  ): Promise<string | null> {
    if (!this.checkpointManager) return null
    try {
      return await this.checkpointManager.create(description, existingPaths, newPaths, agent)
    } catch {
      return null
    }
  }
}
