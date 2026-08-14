/**
 * HiveDB singleton accessor for hiveCode.
 *
 * HiveDB is the only runtime database for hiveCode. It stores mutable
 * document collections, the capability search index, and the durable harness
 * state used by long-running agent tasks.
 */

import path from "node:path";
import { HiveDB } from "@johpaz/hive-db";
import { logger } from "../utils/logger";

const log = logger.child("hivedb");

let db: HiveDB | null = null;
let opening: Promise<HiveDB> | null = null;

export function getHiveDbPath(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  if (env.HIVE_DB_PATH) return path.resolve(cwd, env.HIVE_DB_PATH);
  return path.resolve(cwd, "hivecode");
}

export function getDbPathLazy(): string {
  return getHiveDbPath();
}

export async function getHiveDb(): Promise<HiveDB> {
  if (db) return db;
  if (!opening) {
    const dbPath = getHiveDbPath();
    opening = HiveDB.open(dbPath).then((opened) => {
      db = opened;
      log.info(`[hivedb] Opened at ${dbPath}`);
      return opened;
    });
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}

export function closeHiveDb(): void {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    log.warn(`[hivedb] Error closing database: ${(err as Error).message}`);
  }
  db = null;
  opening = null;
}
