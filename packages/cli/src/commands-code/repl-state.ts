import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

export type ReplMode = "plan" | "approval" | "auto"

function isReplMode(value: unknown): value is ReplMode {
  return value === "plan" || value === "approval" || value === "auto"
}

export function loadInitialState() {
  const db = getDb()
  const configuredMode = (db.query("SELECT value FROM code_config WHERE key = 'default_mode'").get() as any)?.value
  const mode: ReplMode = isReplMode(configuredMode) ? configuredMode : "auto"
  const provider = (db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get() as any)?.value ?? ""
  const model = provider
    ? (db.query("SELECT value FROM code_config WHERE key = ?").get(`provider_model_${provider}`) as any)?.value ?? ""
    : ""
  const projectPath =
    (db.query("SELECT project_path FROM code_sessions ORDER BY id DESC LIMIT 1").get() as any)?.project_path ?? process.cwd()
  const taskCount =
    (db.query("SELECT COUNT(*) as c FROM code_tasks WHERE status NOT IN ('cancelled','completed')").get() as any)?.c ?? 0
  const traceTokens =
    Number((db.query("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as t FROM code_traces").get() as any)?.t ?? 0)
  const taskTokens =
    Number((db.query("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as t FROM code_tasks").get() as any)?.t ?? 0)
  const tokenCount = Math.max(traceTokens, taskTokens)
  return { mode, provider, model, projectPath, taskCount, tokenCount }
}

/** Store the initial policy preference for new requests. Active tasks keep their effective policy. */
export function saveMode(mode: ReplMode): void {
  try {
    getDb().query("INSERT OR REPLACE INTO code_config (key, value) VALUES ('default_mode', ?)").run(mode)
  } catch {
    // A mode switch remains usable if preference persistence is unavailable.
  }
}
