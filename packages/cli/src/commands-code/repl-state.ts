import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

export type ReplMode = "plan" | "approval" | "auto"

export function loadInitialState() {
  const db = getDb()
  // Mode is never persisted — always starts as auto (runtime-only state)
  const mode: ReplMode = "auto"
  const provider = (db.query("SELECT value FROM code_config WHERE key = 'default_provider'").get() as any)?.value ?? ""
  const model = provider
    ? (db.query("SELECT value FROM code_config WHERE key = ?").get(`provider_model_${provider}`) as any)?.value ?? ""
    : ""
  const projectPath =
    (db.query("SELECT project_path FROM code_sessions ORDER BY id DESC LIMIT 1").get() as any)?.project_path ?? process.cwd()
  const taskCount =
    (db.query("SELECT COUNT(*) as c FROM code_tasks WHERE status NOT IN ('cancelled','completed')").get() as any)?.c ?? 0
  const tokenCount =
    (db.query("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as t FROM code_traces").get() as any)?.t ?? 0
  return { mode, provider, model, projectPath, taskCount, tokenCount }
}
