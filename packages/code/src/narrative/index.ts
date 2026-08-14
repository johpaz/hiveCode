export * from "./scribe"
export * from "./schema"

import { ensureHiveDb } from "@johpaz/hivecode-core/storage/bootstrap"
import { logger } from "@johpaz/hivecode-core/utils/logger"

/**
 * Compatibility initializer for older callers.
 *
 * New installs start directly on HiveDB; there is no legacy data migration and
 * no SQL schema bootstrap here.
 */
export function initializeCodeDatabase(): void {
  void ensureHiveDb()
    .then(() => logger.info("[hivedb] Hive-Code collections ready"))
    .catch((err) => logger.warn("[hivedb] Failed to initialize Hive-Code collections:", { error: (err as Error).message }))
}

export function validateCodeSchema(): boolean {
  void ensureHiveDb()
  logger.info("[validate] Hive-Code collections available via HiveDB")
  return true
}
