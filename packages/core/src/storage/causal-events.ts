/**
 * Live-tail wrapper over HiveDB's G9 causal event log (subscribe()/events()).
 *
 * Read-side. The write side is appendCausalEvent() in agent-loop.ts, which is
 * write-only and stays module-private there. This is its watch counterpart,
 * co-located with the DB singleton accessor.
 */
import { getHiveDb } from "./hivedb"
import type { Event, EventPattern } from "@johpaz/hive-db"

export type { Event as CausalEvent, EventPattern as CausalEventPattern }

/**
 * Whether the G9 causal log is being written.
 *
 * Off unless HIVE_CAUSAL_LOG is set, because appending an event per tool call
 * costs a durable write on the turn's hot path. Everything downstream
 * (buildAgentContext, the reflector's harness evaluation) degrades to inert when
 * this is off, so turning it on changes what the system can learn about itself,
 * not whether it runs.
 */
export function causalLogEnabled(): boolean {
  const v = process.env.HIVE_CAUSAL_LOG
  return v === "1" || v?.toLowerCase() === "true"
}

/**
 * Live-tail causal events matching `pattern`. Forward-only: only events appended
 * AFTER this call resolves are delivered. hive-db's subscribe()/events() are a
 * pure in-process pub/sub — dispatched right after the durable write, with no
 * read of the log on subscribe — so there is no historical replay. Combine with
 * causalThread()/read(seq) if backfill is ever needed.
 *
 * `pattern.kind` matches exactly one kind at a time, not an OR: call this once
 * per kind if you need more than one.
 *
 * Process constraint: getHiveDb() opens the database exclusively, with no
 * shared or read-only mode. A second process opening the same DB fails fast with
 * an "already open" error — so this can only be called from within the process
 * that already has it open (the gateway).
 */
export async function watchCausalEvents(
  pattern: EventPattern,
): Promise<AsyncIterable<Event> & { close(): void }> {
  const db = await getHiveDb()
  return db.events(pattern)
}

/** One-line human-readable summary of a causal event, keyed by its kindTag. */
export function formatCausalEvent(event: Event): string {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(event.payload)
  } catch {
    // Malformed payload — still print seq/kind/agent/stream below.
  }

  const streamShort = event.streamId.slice(0, 8)
  const header = `[${event.seq}] ${kindIcon(event.kindTag)} ${event.kindTag.padEnd(16)} agent=${event.agentId}  stream=${streamShort}…`

  switch (event.kindTag) {
    case "IntentLogged":
      return `${header}  "${truncate(String(payload.intent ?? ""), 120)}"`
    case "StateTransition":
      return `${header}  "${truncate(String(payload.description ?? ""), 120)}"`
    case "ToolCall": {
      const outcome = payload.outcome
      const outcomeStr =
        outcome === "Ok" ? "ok"
          : outcome === "Timeout" ? "TIMEOUT"
            : (outcome && typeof outcome === "object" && "Err" in (outcome as object))
              ? `ERR: ${(outcome as { Err: string }).Err}`
              : String(outcome)
      const latency = payload.latency_ms !== undefined ? `${payload.latency_ms}ms` : "?ms"
      return `${header}  tool=${payload.tool}  ${latency}  ${outcomeStr}`
    }
    default:
      return `${header}  ${truncate(JSON.stringify(payload), 120)}`
  }
}

function kindIcon(kindTag: string): string {
  switch (kindTag) {
    case "IntentLogged": return "🎯"
    case "StateTransition": return "🔀"
    case "ToolCall": return "🔧"
    case "LearningProposal": return "📄"
    default: return "•"
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s
}