export * from "./scribe"
export * from "./schema"

import { getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { CODE_SCHEMA } from "./schema"
import { logger } from "@johpaz/hive-code-core/utils/logger"

/**
 * Initialize Hive-Code specific tables (code_sessions, code_tasks, code_narrative, etc.)
 * Must be called AFTER initializeDatabase() from the core.
 */
export function initializeCodeDatabase(): void {
  try {
    const db = getDb()
    db.run(CODE_SCHEMA)
    logger.info("🗄️  Hive-Code schema initialized (code_* tables)")
  } catch (err) {
    logger.warn("⚠️  Failed to initialize Hive-Code schema:", { error: (err as Error).message })
  }
}

/**
 * Validate that all required Hive-Code tables exist.
 * Throws if any required table is missing.
 */
export function validateCodeSchema(): boolean {
  const db = getDb()
  const requiredTables = [
    "code_sessions",
    "code_tasks",
    "code_narrative",
    "code_decisions",
    "code_file_snapshots",
    "code_task_phases",
    "code_traces",
    "code_playbook",
    "code_reflections",
    "code_context_cache",
    "code_config",
  ]

  for (const table of requiredTables) {
    const exists = db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
    ).get(table) as { name: string } | undefined

    if (!exists) {
      throw new Error(`Missing required Hive-Code table: ${table}`)
    }
  }

  logger.info("[validate] ✅ All code_* tables present")
  return true
}
