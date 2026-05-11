/**
 * Context Compiler Cache L1
 *
 * In-memory cache for compiled context with automatic invalidation.
 * Key: {agentId}:{threadId}:{MAX(rowid) de traces}
 * Invalidation: automatic cuando cambia MAX(rowid) de SQLite.
 *
 * SPEC §9: "Cache L1 para el Context Compiler. Invalidación por MAX(rowid) de SQLite."
 */

import { getDb } from "@johpaz/hive-code-core/storage/sqlite"

interface CacheEntry {
  value: string
  ts: number
  traceRowid: number
}

const cache = new Map<string, CacheEntry>()

let lastKnownMaxRowid = 0

function getMaxTraceRowid(): number {
  try {
    const db = getDb()
    const row = db.query("SELECT MAX(rowid) as max_id FROM traces").get() as { max_id: number } | null
    return row?.max_id ?? 0
  } catch {
    return 0
  }
}

/**
 * Get cached compiled context if valid.
 * Returns undefined if cache miss or invalidated.
 */
export function getCachedContext(agentId: string, threadId: string): string | undefined {
  const currentMax = getMaxTraceRowid()

  // Global invalidation: if traces changed, invalidate ALL entries
  if (currentMax !== lastKnownMaxRowid) {
    lastKnownMaxRowid = currentMax
    cache.clear()
    return undefined
  }

  const key = `${agentId}:${threadId}:${currentMax}`
  const entry = cache.get(key)

  if (!entry) return undefined

  // Optional TTL: invalidate entries older than 5 minutes
  const now = Date.now()
  if (now - entry.ts > 5 * 60 * 1000) {
    cache.delete(key)
    return undefined
  }

  return entry.value
}

/**
 * Store compiled context in cache.
 */
export function setCachedContext(agentId: string, threadId: string, value: string): void {
  const currentMax = getMaxTraceRowid()
  lastKnownMaxRowid = currentMax
  const key = `${agentId}:${threadId}:${currentMax}`
  cache.set(key, { value, ts: Date.now(), traceRowid: currentMax })
}

/**
 * Clear all cached entries.
 */
export function clearContextCache(): void {
  cache.clear()
  lastKnownMaxRowid = 0
}

/**
 * Cache stats for diagnostics.
 */
export function getContextCacheStats(): { size: number; lastMaxRowid: number } {
  return { size: cache.size, lastMaxRowid: lastKnownMaxRowid }
}
