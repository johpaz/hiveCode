/**
 * Stuck-loop and stall detection.
 *
 * RepeatTracker (agent-loop.ts) answers "is the model repeating itself". This
 * answers the two questions that survive that:
 *
 *  - loop: the same tool, the same arguments, failing — the model is retrying
 *    something that cannot work and will retry it until the budget is gone.
 *  - stall: nothing is repeating, no tool is erroring, and yet nothing is
 *    advancing. This is the expensive one, because every other signal looks
 *    healthy and the run still burns its whole budget.
 *
 * Detection is observational: it produces an intervention message for the model
 * and a status for the caller. It never ends a run on its own.
 */
import { hashObject } from "../utils/crypto"

interface ToolCallRecord {
  toolName: string
  argsHash: string
  errorMessage?: string
  timestamp: number
}

interface ProgressRecord {
  hash: string
  timestamp: number
}

export interface StuckLoopState {
  detected: boolean
  toolName: string
  count: number
  lastError?: string
  kind: "loop" | "stall"
}

export class StuckLoopDetector {
  private history = new Map<string, ToolCallRecord[]>()
  private progressHistory = new Map<string, ProgressRecord[]>()
  private readonly maxHistoryPerSession = 50
  /** Same tool, same args, still failing, this many times. */
  private readonly triggerThreshold = 3
  /** Identical progress snapshots this many times running. */
  private readonly progressThreshold = 3

  recordToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    error?: string,
  ): void {
    let sessionHistory = this.history.get(sessionId)
    if (!sessionHistory) {
      sessionHistory = []
      this.history.set(sessionId, sessionHistory)
    }

    sessionHistory.push({
      toolName,
      argsHash: hashObject(args),
      errorMessage: error,
      timestamp: Date.now(),
    })

    if (sessionHistory.length > this.maxHistoryPerSession) sessionHistory.shift()
  }

  check(sessionId: string): StuckLoopState {
    const sessionHistory = this.history.get(sessionId) ?? []
    if (sessionHistory.length < this.triggerThreshold) {
      return { detected: false, toolName: "", count: 0, kind: "loop" }
    }

    // Only the recent tail: an old failure that was since resolved is history,
    // not a loop.
    const recent = sessionHistory.slice(-10)
    const counts = new Map<string, { count: number; error?: string }>()

    for (const record of recent) {
      const key = `${record.toolName}:${record.argsHash}`
      const existing = counts.get(key)
      if (existing) {
        existing.count++
        if (record.errorMessage) existing.error = record.errorMessage
      } else {
        counts.set(key, { count: 1, error: record.errorMessage })
      }
    }

    for (const [key, data] of counts) {
      if (data.count >= this.triggerThreshold && data.error) {
        return {
          detected: true,
          toolName: key.split(":")[0] ?? "unknown",
          count: data.count,
          lastError: data.error,
          kind: "loop",
        }
      }
    }

    return { detected: false, toolName: "", count: 0, kind: "loop" }
  }

  /**
   * Record a fingerprint of what the run has actually achieved. Call this with
   * something that changes only when the run is genuinely making progress —
   * files written, tests passing, state advanced — not a transcript hash, which
   * moves on every turn by construction.
   */
  recordProgress(sessionId: string, progressHash: string): void {
    let sessionProgress = this.progressHistory.get(sessionId)
    if (!sessionProgress) {
      sessionProgress = []
      this.progressHistory.set(sessionId, sessionProgress)
    }
    sessionProgress.push({ hash: progressHash, timestamp: Date.now() })
    if (sessionProgress.length > this.maxHistoryPerSession) sessionProgress.shift()
  }

  /** Detect a run that is busy but not advancing. */
  checkProgress(sessionId: string, threshold?: number): StuckLoopState {
    const sessionProgress = this.progressHistory.get(sessionId) ?? []
    const required = threshold ?? this.progressThreshold
    if (sessionProgress.length < required) {
      return { detected: false, toolName: "", count: 0, kind: "stall" }
    }

    const recent = sessionProgress.slice(-required)
    const firstHash = recent[0]?.hash
    const allSame = recent.every(r => r.hash === firstHash)

    if (allSame && firstHash) {
      return { detected: true, toolName: "NO_PROGRESS", count: required, kind: "stall" }
    }

    return { detected: false, toolName: "", count: 0, kind: "stall" }
  }

  clear(sessionId: string): void {
    this.history.delete(sessionId)
    this.progressHistory.delete(sessionId)
  }

  /** Drop sessions nothing has touched recently, so the maps stay bounded. */
  prune(maxAgeMs: number = 30 * 60 * 1000): number {
    const now = Date.now()
    let pruned = 0

    for (const [sessionId, records] of this.history) {
      const kept = records.filter(r => now - r.timestamp < maxAgeMs)
      if (kept.length === 0) {
        this.history.delete(sessionId)
        pruned++
      } else if (kept.length !== records.length) {
        this.history.set(sessionId, kept)
      }
    }

    for (const [sessionId, records] of this.progressHistory) {
      const kept = records.filter(r => now - r.timestamp < maxAgeMs)
      if (kept.length === 0) {
        this.progressHistory.delete(sessionId)
        pruned++
      } else if (kept.length !== records.length) {
        this.progressHistory.set(sessionId, kept)
      }
    }

    return pruned
  }
}

export function createStuckLoopDetector(): StuckLoopDetector {
  return new StuckLoopDetector()
}

/**
 * What to tell the model. Escalating, because the cheapest intervention is the
 * one that works: the first retry only rarely needs to stop the run, and a run
 * that stops on the third hiccup is worse than one that adapts.
 */
export function getInterventionMessage(state: StuckLoopState): string {
  if (!state.detected) return ""

  if (state.kind === "stall") {
    return `WARNING: No avanzaste durante ${state.count} ciclos consecutivos. Revisá tu plan, probá una herramienta distinta o pedile aclaración al usuario en vez de repetir la misma secuencia.`
  }

  if (state.count >= 4) {
    return `CRITICAL: Llamaste ${state.toolName} ${state.count} veces con los mismos argumentos y sigue fallando con: "${state.lastError}". El usuario será notificado. Cambiá por completo de estrategia o pedí ayuda.`
  }

  return `WARNING: Llamaste ${state.toolName} ${state.count} veces con los mismos argumentos y sigue fallando. Probá un enfoque diferente en vez de repetir la misma acción.`
}