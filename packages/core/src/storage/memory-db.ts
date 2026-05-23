import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import * as path from "node:path"
import { getHiveDir } from "../config/loader"
import { logger } from "../utils/logger"
import { MEMORY_SCHEMA } from "./memory-schema"

const log = logger.child("memory-db")
let _memDb: Database | null = null

export function getMemoryDbPath(): string {
  return path.join(getHiveDir(), "memory.db")
}

export function initializeMemoryDb(): Database {
  const hiveDir = getHiveDir()
  if (!existsSync(hiveDir)) {
    mkdirSync(hiveDir, { recursive: true })
  }

  const dbPath = getMemoryDbPath()
  _memDb = new Database(dbPath, { create: true })

  _memDb.run(`PRAGMA journal_mode = WAL`)
  _memDb.run(`PRAGMA synchronous = NORMAL`)
  _memDb.run(`PRAGMA cache_size = -64000`)
  _memDb.run(`PRAGMA temp_store = MEMORY`)
  _memDb.run(`PRAGMA mmap_size = 268435456`)
  _memDb.run(`PRAGMA foreign_keys = ON`)

  for (const stmt of MEMORY_SCHEMA) {
    _memDb.run(stmt)
  }

  log.info(`Memory DB initialized: ${dbPath}`)
  return _memDb
}

export function getMemoryDb(): Database {
  if (!_memDb) throw new Error("Memory DB not initialized. Call initializeMemoryDb() first.")
  return _memDb
}

export function closeMemoryDb(): void {
  if (_memDb) {
    _memDb.close()
    _memDb = null
  }
}
