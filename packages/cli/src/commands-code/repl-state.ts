import { loadCodeCliState, setCodeConfig } from "./provider-store"

export type ReplMode = "plan" | "approval" | "auto"

function isReplMode(value: unknown): value is ReplMode {
  return value === "plan" || value === "approval" || value === "auto"
}

export async function loadInitialState() {
  const state = await loadCodeCliState()
  const mode: ReplMode = isReplMode(state.mode) ? state.mode : "approval"
  return { ...state, mode }
}

/** Store the initial policy preference for new requests. Active tasks keep their effective policy. */
export async function saveMode(mode: ReplMode): Promise<void> {
  try {
    await setCodeConfig("default_mode", mode)
  } catch {
    // A mode switch remains usable if preference persistence is unavailable.
  }
}
