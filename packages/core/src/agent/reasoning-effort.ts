/**
 * How hard a reasoning model is asked to think — decided by the harness, not by a screen setting.
 *
 * A reasoning model given no limit spends most of its output thinking. Measured on minimax-m3.1 with
 * the same 15-call coding task (31/31 hidden tests both times):
 *
 *   no limit            11.4 min · 59 K output tokens (~48 K reasoning) · 678 s in the model
 *   reasoning_effort=low  3.7 min · 13 K output tokens (~6 K reasoning)  · 218 s in the model
 *
 * Wall-clock was ~99 % model time at ~90 tokens/s, so the reasoning tokens were the time. The thinking
 * that paid off was the first design turn and the turns after a failure; most of the rest was
 * mechanical (write a file already decided, run the tests).
 *
 * So a run carries a policy — a `base` level and a higher one for the turn after something failed —
 * chosen from the route, the phase and the profile. The agent's own `effort` (a TUI preference) is
 * only the last resort, for agents that are not part of the harness.
 */
export type ReasoningEffort = "low" | "medium" | "high"

export interface ReasoningPolicy {
  /** Level for an ordinary turn. */
  base: ReasoningEffort
  /** Level for the turn right after a tool call failed: debugging is where thinking pays. */
  onFailure: ReasoningEffort
}

const LEVELS = new Set<string>(["low", "medium", "high"])
const OFF = new Set<string>(["off", "none", "default"])

/** The model catalog marks models that think with the "reasoning" capability. */
export function modelReasons(capabilitiesJson: string | null | undefined): boolean {
  try {
    const parsed = JSON.parse(capabilitiesJson ?? "[]")
    return Array.isArray(parsed) && parsed.includes("reasoning")
  } catch {
    return false
  }
}

const fixed = (level: ReasoningEffort): ReasoningPolicy => ({ base: level, onFailure: level })

/** The TUI's effort scale, as a last resort for agents the harness does not manage. */
function fromAgentEffort(effort: string | undefined): ReasoningPolicy | undefined {
  switch (effort) {
    case "low": return fixed("low")
    case "medium": return fixed("medium")
    case "high": case "xhigh": case "max": return fixed("high")
    default: return undefined
  }
}

export interface ReasoningInputs {
  /** What the harness decided for this run (route and phase). */
  run?: ReasoningPolicy
  /** The profile's own default (`CORE_AGENT_DEFINITIONS[...].reasoning`). */
  profile?: ReasoningPolicy
  /** The agent's `effort`, set from the TUI. Only used when nothing above decides. */
  agentEffort?: string
  capabilitiesJson: string | null | undefined
  env?: Record<string, string | undefined>
}

/**
 * The policy for a run, or `undefined` to send nothing. Precedence: the operator's
 * `HIVECODE_REASONING_EFFORT` (`low|medium|high`, or `off`), then the harness's decision, then the
 * profile, then the agent's `effort`. Only for models that reason: a field a model does not know can
 * be rejected rather than ignored.
 */
export function resolveReasoningPolicy(input: ReasoningInputs): ReasoningPolicy | undefined {
  if (!modelReasons(input.capabilitiesJson)) return undefined
  const override = (input.env ?? process.env).HIVECODE_REASONING_EFFORT?.trim().toLowerCase()
  if (override && OFF.has(override)) return undefined
  if (override && LEVELS.has(override)) return fixed(override as ReasoningEffort)
  return input.run ?? input.profile ?? fromAgentEffort(input.agentEffort)
}

/** The level for one turn: escalate right after a failure, otherwise the base. */
export function chooseReasoningEffort(policy: ReasoningPolicy | undefined, previousTurnFailed: boolean): ReasoningEffort | undefined {
  if (!policy) return undefined
  return previousTurnFailed ? policy.onFailure : policy.base
}
