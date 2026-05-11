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
