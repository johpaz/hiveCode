import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import * as path from "node:path"
import { getHiveDir } from "../config/loader.ts"
import { SESSION_SCHEMA } from "./schema.ts"

const SESSIONS_DIR = () => path.join(getHiveDir(), "sessions")

const _dbs = new Map<string, Database>()

export function getSessionDb(sessionId: string): Database {
  const existing = _dbs.get(sessionId)
  if (existing) return existing
  return openSessionDb(sessionId)
}

export function openSessionDb(sessionId: string): Database {
  const dir = SESSIONS_DIR()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const dbPath = path.join(dir, `${sessionId}.db`)
  const db = new Database(dbPath, { create: true })

  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA cache_size = -16000")
  db.run("PRAGMA temp_store = MEMORY")

  applySchema(db)
  _dbs.set(sessionId, db)
  return db
}

export function closeSessionDb(sessionId: string): void {
  const db = _dbs.get(sessionId)
  if (db) {
    db.close()
    _dbs.delete(sessionId)
  }
}

export function closeAllSessionDbs(): void {
  for (const [id, db] of _dbs) {
    db.close()
    _dbs.delete(id)
  }
}

function applySchema(db: Database): void {
  db.transaction(() => {
    for (const stmt of SESSION_SCHEMA) {
      db.run(stmt)
    }
  })()
}
