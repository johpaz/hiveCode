/**
 * Hive-Code seed entrypoint.
 *
 * New installs bootstrap directly through HiveDB. Core catalogs, providers,
 * skills, tools, agents and indexes are owned by `storage/bootstrap`.
 */

import { ensureHiveDb } from "@johpaz/hivecode-core/storage/bootstrap"
import { logger } from "@johpaz/hivecode-core/utils/logger"

const log = logger.child("code-seed")

export async function seedCodeData(_force = false): Promise<void> {
  try {
    await ensureHiveDb()
    log.info("[seed] Hive-Code HiveDB bootstrap complete")
  } catch (err) {
    log.error("[seed] Hive-Code seed failed:", (err as Error).message)
  }
}
