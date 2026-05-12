import { Database } from "bun:sqlite"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { SCHEMA, PROJECTS_SCHEMA, CONTEXT_ENGINE_SCHEMA, MEETING_SCHEMA } from "@johpaz/hive-code-core/storage/schema"
import { _setDb, _resetDb } from "@johpaz/hive-code-core/storage/sqlite"
import { CODE_SCHEMA } from "../../src/narrative/schema"

let _testDb: Database | null = null
let _testDir: string = ""

export function getTestDb(): Database {
  if (_testDb) return _testDb
  _testDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-test-"))
  const dbPath = path.join(_testDir, "test.db")
  _testDb = new Database(dbPath, { create: true })
  _testDb.run("PRAGMA journal_mode = WAL")
  _testDb.run("PRAGMA foreign_keys = ON")
  _testDb.run(SCHEMA)
  _testDb.run(PROJECTS_SCHEMA)
  _testDb.run(CONTEXT_ENGINE_SCHEMA)
  _testDb.run(MEETING_SCHEMA)
  _testDb.run(CODE_SCHEMA)
  _setDb(_testDb)
  return _testDb
}

export function cleanupTestDb(): void {
  if (_testDb) {
    _testDb.close()
    _testDb = null
  }
  _resetDb()
  if (_testDir && fs.existsSync(_testDir)) {
    fs.rmSync(_testDir, { recursive: true, force: true })
    _testDir = ""
  }
}

export function resetTestDb(): void {
  cleanupTestDb()
  getTestDb()
}
