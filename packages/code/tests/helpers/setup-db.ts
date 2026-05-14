import { Database } from "bun:sqlite"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { SCHEMA, PROJECTS_SCHEMA, CONTEXT_ENGINE_SCHEMA, MEETING_SCHEMA } from "@johpaz/hivecode-core/storage/schema"
import { _setDb, _resetDb } from "@johpaz/hivecode-core/storage/sqlite"
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

export function seedProvider(
  id: string,
  name: string = id,
  opts: { baseUrl?: string; enabled?: number; apiKey?: string } = {},
): void {
  const db = getTestDb()
  db.query(
    "INSERT OR REPLACE INTO providers (id, name, base_url, enabled) VALUES (?, ?, ?, ?)",
  ).run(id, name, opts.baseUrl ?? null, opts.enabled ?? 1)
  if (opts.apiKey) {
    db.query("UPDATE providers SET api_key_encrypted = ? WHERE id = ?").run(
      Buffer.from(opts.apiKey).toString("base64"),
      id,
    )
  }
}

export function seedConfig(key: string, value: string): void {
  getTestDb()
    .query("INSERT OR REPLACE INTO code_config (key, value) VALUES (?, ?)")
    .run(key, value)
}
