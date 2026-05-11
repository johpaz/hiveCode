/**
 * Database initialization helper for Hive-Code commands.
 * Ensures both core and code schemas are applied before use.
 */

import { initializeDatabase, getDb } from "@johpaz/hive-code-core/storage/sqlite"
import { initializeCodeDatabase } from "@johpaz/hive-code-code/narrative"

/**
 * Initialize database if not already done. Idempotent — safe to call multiple times.
 */
export function ensureCodeDatabase(): void {
  try {
    getDb()
    // DB already initialized — just ensure code schema
    initializeCodeDatabase()
  } catch {
    // DB not initialized — initialize both
    initializeDatabase()
    initializeCodeDatabase()
  }
}
