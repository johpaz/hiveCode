/**
 * Migration from the cwd-relative database to the HiveDir one.
 *
 * Deliberately NOT automatic. Moving a redb directory that another process may
 * hold is exactly the operation you do not perform behind someone's back: the
 * gateway is exclusive-open, so a copy made while it is running is a copy of a
 * live file and may not be consistent.
 *
 * So this is a command the user runs, with a preflight that tells them what
 * will happen before anything moves, and a refusal rather than a guess when the
 * destination already holds data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getHiveDbPath,
  getLegacyHiveDbPath,
  findLegacyHiveDb,
  ensureHiveDbDir,
} from "./hivedb";

export interface MigrationPreflight {
  from: string;
  to: string;
  /** Bytes that will be moved. */
  bytes: number;
  files: string[];
  /** Set when the destination already exists and holds data. */
  destinationOccupied: boolean;
  /** Set when the destination exists but looks empty/replaceable. */
  destinationEmpty: boolean;
}

function dirBytes(dir: string): { bytes: number; files: string[] } {
  let bytes = 0;
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = dirBytes(full);
      bytes += nested.bytes;
      files.push(...nested.files.map((f) => path.join(entry.name, f)));
    } else {
      bytes += fs.statSync(full).size;
      files.push(entry.name);
    }
  }
  return { bytes, files };
}

/** What a migration would do, without doing any of it. */
export function preflightMigration(cwd = process.cwd()): MigrationPreflight | null {
  const from = findLegacyHiveDb(cwd);
  if (!from) return null;

  const { bytes, files } = dirBytes(from);
  const to = getHiveDbPath();
  const destinationExists = fs.existsSync(to);
  let destinationOccupied = false;
  if (destinationExists) {
    const dest = dirBytes(to);
    destinationOccupied = dest.bytes > 0;
  }

  return {
    from,
    to,
    bytes,
    files: files.sort(),
    destinationOccupied,
    destinationEmpty: destinationExists && !destinationOccupied,
  };
}

/**
 * Move the legacy database to its new home.
 *
 * The destination is left untouched if it already holds data — that is the one
 * case where "I overwrote your current database" would be unrecoverable, and the
 * caller is expected to have read the preflight first.
 */
export function migrateLegacyDb(opts: { force?: boolean } = {}): { ok: boolean; error?: string } {
  const pre = preflightMigration();
  if (!pre) return { ok: false, error: "No legacy database found in this directory" };
  if (pre.destinationOccupied && !opts.force) {
    return {
      ok: false,
      error: `Destination already holds a database (${pre.to}). Nothing was moved.\n`
        + `Move it aside yourself, then re-run — or pass force if you are certain.`,
    };
  }

  try {
    ensureHiveDbDir(pre.to)
    // Rename first: it is atomic within a filesystem and fails loudly rather
    // than half-copying. A cross-device move falls back to copy-then-remove.
    try {
      fs.renameSync(pre.from, pre.to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      fs.cpSync(pre.from, pre.to, { recursive: true });
      fs.rmSync(pre.from, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** One line for `doctor`: where the data actually is, and whether it moved. */
export function describeDbLocation(): string {
  const current = getHiveDbPath()
  const legacy = getLegacyHiveDbPath()
  return current === legacy
    ? `${current} (cwd-relative)`
    : `${current}`
}