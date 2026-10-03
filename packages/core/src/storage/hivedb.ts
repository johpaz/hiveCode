/**
 * HiveDB singleton accessor for hiveCode.
 *
 * HiveDB is the only runtime database for hiveCode. It stores mutable
 * document collections, the capability search index, and the durable harness
 * state used by long-running agent tasks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveDB } from "@johpaz/hive-db";
import { logger } from "../utils/logger";

const log = logger.child("hivedb");

let db: HiveDB | null = null;
let opening: Promise<HiveDB> | null = null;

/** Directory the database lives under, inside whichever HiveDir was resolved. */
const DB_SUBDIR = path.join("data", "hivedb");

/**
 * Where the database lives.
 *
 * Precedence, in order:
 *   1. HIVE_DB_PATH  — explicit override. Tests, containers, ":memory:".
 *   2. HIVE_HOME     — a chosen HiveDir; the database follows the rest of it.
 *   3. ~/.hivecode   — the default.
 *
 * Never relative to the working directory. A cwd-relative database means a
 * different directory is a different — and completely empty — installation:
 * agents, sessions, memory and durable run state all vanish because you cd'd.
 * Every other piece of persistent state (config.json, gateway.pid, logs,
 * screenshots) has always been global; this brings the database in line.
 *
 * HIVE_DEV deliberately does NOT appear here. It selects the debug TUI binary
 * and the log level — and putting the database under it was tried and reverted:
 * `bun run dev` sets it, so a dev loop would silently get a second, empty
 * database inside the repo, in a directory nothing gitignores. One database,
 * one place. A dev run that needs its own state sets HIVE_DB_PATH.
 */
export function getHiveDbPath(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  if (env.HIVE_DB_PATH) return path.resolve(cwd, env.HIVE_DB_PATH);

  if (env.HIVE_HOME) {
    const home = env.HIVE_HOME.startsWith("~")
      ? path.join(os.homedir(), env.HIVE_HOME.slice(1))
      : env.HIVE_HOME;
    return path.join(home, DB_SUBDIR);
  }

  return path.join(os.homedir(), ".hivecode", DB_SUBDIR);
}

/**
 * The pre-0.1 location: a `hivecode/` directory in whatever cwd the process
 * happened to start in. Reported so a user can be told exactly what to move,
 * rather than silently starting over with an empty database.
 */
export function getLegacyHiveDbPath(cwd = process.cwd()): string {
  return path.resolve(cwd, "hivecode");
}

/**
 * A legacy directory holding a real database, if one is there.
 *
 * A bare `hivecode/` folder in someone's project is not evidence of anything —
 * only the redb files inside it are.
 */
export function findLegacyHiveDb(cwd = process.cwd()): string | null {
  const legacy = getLegacyHiveDbPath(cwd);
  if (legacy === getHiveDbPath()) return null;
  try {
    const entries = fs.readdirSync(legacy);
    if (entries.some((f) => f.endsWith(".redb"))) return legacy;
  } catch {
    // No such directory — the common case.
  }
  return null;
}

/** Create the parent directory so HiveDB.open() cannot fail on a missing path. */
export function ensureHiveDbDir(dbPath = getHiveDbPath()): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

export function getDbPathLazy(): string {
  return getHiveDbPath();
}

export async function getHiveDb(): Promise<HiveDB> {
  if (db) return db;
  if (!opening) {
    const dbPath = getHiveDbPath();
    const isNew = !fs.existsSync(dbPath);
    ensureHiveDbDir(dbPath);
    opening = HiveDB.open(dbPath).then((opened) => {
      db = opened;
      log.info(`[hivedb] Opened at ${dbPath}`);
      if (isNew) warnIfLegacyDbExists();
      return opened;
    });
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}

/**
 * The dangerous case after the move to HiveDir: this process just created a
 * fresh database while the user's real one sits in an old cwd-relative
 * directory. Nothing errors — it looks like a first run, and the old agents,
 * sessions and memory read as deleted.
 *
 * So say it once, loudly, the moment it happens.
 */
let legacyWarned = false;
function warnIfLegacyDbExists(): void {
  if (legacyWarned) return;
  const legacy = findLegacyHiveDb();
  if (!legacy) return;
  legacyWarned = true;
  log.warn(
    `[hivedb] A previous installation's database still exists at ${legacy} and is NOT being used. `
    + `Agents, sessions and memory from it will look missing. `
    + `Run: hivecode doctor --migrate-db  (from ${process.cwd()})`,
  );
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
