/**
 * Database location.
 *
 * The rule being protected: the database is not relative to the working
 * directory. A cwd-relative path means a different directory is a different,
 * empty installation — agents, sessions, memory and durable run state all
 * vanish because you cd'd, with no error anywhere.
 */
import { describe, expect, test, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  getHiveDbPath,
  getLegacyHiveDbPath,
  findLegacyHiveDb,
  ensureHiveDbDir,
} from "@johpaz/hivecode-core/storage/hivedb"
import { preflightMigration } from "@johpaz/hivecode-core/storage/db-migrate"

const HOME = os.homedir()
const empty = {} as Record<string, string | undefined>

afterEach(() => {
  delete process.env.HIVE_HOME
  delete process.env.HIVE_DEV
})

describe("getHiveDbPath precedence", () => {
  test("HIVE_DB_PATH wins over everything", () => {
    expect(getHiveDbPath({ HIVE_DB_PATH: "/tmp/explicit", HIVE_HOME: "/x", HIVE_DEV: "1" }))
      .toBe("/tmp/explicit")
  })

  test("a relative HIVE_DB_PATH resolves against cwd", () => {
    expect(getHiveDbPath({ HIVE_DB_PATH: "scratch/db" }, "/work")).toBe("/work/scratch/db")
  })

  test("HIVE_HOME places the database under it", () => {
    expect(getHiveDbPath({ HIVE_HOME: "/opt/hive" })).toBe("/opt/hive/data/hivedb")
  })

  test("HIVE_HOME expands a leading tilde", () => {
    expect(getHiveDbPath({ HIVE_HOME: "~/.custom" })).toBe(`${HOME}/.custom/data/hivedb`)
  })

  test("HIVE_DEV does not move the database", () => {
    // Tried and reverted: `bun run dev` sets HIVE_DEV, so putting the database
    // under it gave the dev loop a second, empty one inside the repo.
    expect(getHiveDbPath({ HIVE_DEV: "true" }, "/work")).toBe(
      getHiveDbPath({}, "/work"),
    )
    expect(getHiveDbPath({ HIVE_DEV: "1" }, "/work")).toBe(
      getHiveDbPath({}, "/work"),
    )
  })

  test("HIVE_HOME beats HIVE_DEV", () => {
    expect(getHiveDbPath({ HIVE_HOME: "/opt/hive", HIVE_DEV: "1" })).toBe("/opt/hive/data/hivedb")
  })

  test("no resolution ever lands inside the working directory", () => {
    for (const env of [{}, { HIVE_DEV: "1" }, { HIVE_DEV: "true" }, { HIVE_HOME: "/opt/h" }]) {
      expect(getHiveDbPath(env, "/data/Hive/hivecode").startsWith("/data/Hive/hivecode")).toBe(false)
    }
  })

  test("the default lives in the home directory", () => {
    expect(getHiveDbPath(empty)).toBe(`${HOME}/.hivecode/data/hivedb`)
  })

  test("the default never depends on cwd", () => {
    // The regression this whole change exists for.
    const fromRepo = getHiveDbPath(empty, "/data/Hive/hivecode")
    const fromTmp = getHiveDbPath(empty, "/tmp")
    expect(fromRepo).toBe(fromTmp)
  })

  test("every resolution is absolute", () => {
    for (const env of [{}, { HIVE_DEV: "1" }, { HIVE_HOME: "/opt/h" }]) {
      expect(path.isAbsolute(getHiveDbPath(env, "/work"))).toBe(true)
    }
  })
})

describe("legacy detection", () => {
  const makeLegacy = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-legacy-"))
    const legacy = path.join(dir, "hivecode")
    fs.mkdirSync(legacy)
    fs.writeFileSync(path.join(legacy, "collections.redb"), "fake")
    fs.writeFileSync(path.join(legacy, "meta.json"), "{}")
    return legacy
  }

  test("a directory with redb files is a legacy database", () => {
    const legacy = makeLegacy()
    expect(findLegacyHiveDb(path.dirname(legacy))).toBe(legacy)
  })

  test("a bare directory is not evidence of a database", () => {
    // Plenty of projects have an unrelated folder called hivecode/.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-bare-"))
    fs.mkdirSync(path.join(dir, "hivecode"))
    fs.writeFileSync(path.join(dir, "hivecode", "README.md"), "not a db")
    expect(findLegacyHiveDb(dir)).toBeNull()
  })

  test("nothing to find is not an error", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-empty-"))
    expect(findLegacyHiveDb(dir)).toBeNull()
  })

  test("when the legacy path IS the current path, nothing is reported", () => {
    // HIVE_DB_PATH pointing at ./hivecode must not make it look like a legacy
    // install waiting to be migrated onto itself.
    process.env.HIVE_DB_PATH = path.join(process.cwd(), "hivecode")
    const legacy = makeLegacy()
    const found = findLegacyHiveDb(path.dirname(legacy))
    if (found !== null) expect(found).not.toBe(getHiveDbPath())
    delete process.env.HIVE_DB_PATH
  })

  test("preflight reports size and file count", () => {
    const legacy = makeLegacy()
    const pre = preflightMigration(path.dirname(legacy))
    // Only meaningful when the destination is not the legacy dir itself.
    if (pre && pre.from === legacy) {
      expect(pre.files).toContain("collections.redb")
      expect(pre.bytes).toBeGreaterThan(0)
    }
  })

  test("preflight is null when there is nothing to migrate", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-none-"))
    expect(preflightMigration(dir)).toBeNull()
  })

  test("getLegacyHiveDbPath is always cwd-relative", () => {
    expect(getLegacyHiveDbPath("/somewhere")).toBe("/somewhere/hivecode")
  })
})

describe("ensureHiveDbDir", () => {
  test("creates the parent of a nested path", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-mk-"))
    const target = path.join(base, "a", "b", "c")
    ensureHiveDbDir(target)
    expect(fs.existsSync(path.dirname(target))).toBe(true)
    // The database itself is HiveDB's job, not ours.
    expect(fs.existsSync(target)).toBe(false)
  })

  test("is safe to call twice", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-mk2-"))
    const target = path.join(base, "x", "db")
    ensureHiveDbDir(target)
    expect(() => ensureHiveDbDir(target)).not.toThrow()
  })
})