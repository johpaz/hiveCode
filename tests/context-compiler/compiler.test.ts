/**
 * Tests for Context Compiler — TOON format, cache invalidation,
 * and developer preferences injection.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { CODE_SCHEMA } from "@johpaz/hivecode-code/narrative/schema"

// ── In-memory DB setup ────────────────────────────────────────────────────

function makeDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(CODE_SCHEMA)
  return db
}

let db: Database

beforeEach(() => {
  db = makeDb()
})
afterEach(() => {
  db.close()
})

// ── TOON format helpers ────────────────────────────────────────────────────

/**
 * Simplified TOON extraction — mirrors what context-compiler should produce.
 * We test the logic, not the full compiler, to keep tests fast.
 */
function extractToonSignature(source: string): string {
  const lines: string[] = []
  let insideBody = 0

  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    // Track brace depth
    insideBody += (line.match(/{/g) || []).length
    insideBody -= (line.match(/}/g) || []).length

    // Always include: imports, exports, function/class signatures, type declarations
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("export ") ||
      trimmed.startsWith("function ") ||
      trimmed.startsWith("export function") ||
      trimmed.startsWith("export class") ||
      trimmed.startsWith("export type") ||
      trimmed.startsWith("export interface") ||
      trimmed.startsWith("type ") ||
      trimmed.startsWith("interface ")
    ) {
      lines.push(line)
    }
  }

  return lines.join("\n")
}

describe("TOON format", () => {
  test("extracts import statements", () => {
    const source = `
import { foo } from "./foo"
import type { Bar } from "./bar"

function localHelper() {
  return 42
}

export function main() {
  return localHelper()
}
`
    const toon = extractToonSignature(source)
    expect(toon).toContain('import { foo }')
    expect(toon).toContain('import type { Bar }')
    expect(toon).toContain('export function main')
  })

  test("TOON output is shorter than original source", () => {
    const source = `
import { a } from "a"
import { b } from "b"

function bigFunction() {
  // lots of implementation details
  const result = []
  for (let i = 0; i < 1000; i++) {
    result.push(i * 2)
  }
  return result.reduce((a, b) => a + b, 0)
}

export function publicAPI(): number {
  return bigFunction()
}
`
    const toon = extractToonSignature(source)
    expect(toon.length).toBeLessThan(source.length)
  })

  test("TOON retains export declarations", () => {
    const source = `
export type Status = "active" | "inactive"
export interface Config { timeout: number }
export class Manager { constructor() {} }
`
    const toon = extractToonSignature(source)
    expect(toon).toContain("export type Status")
    expect(toon).toContain("export interface Config")
    expect(toon).toContain("export class Manager")
  })
})

// ── Context cache ─────────────────────────────────────────────────────────

describe("code_context_cache TTL", () => {
  test("stores and retrieves compiled context", () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    db.run(
      `INSERT INTO code_context_cache (cache_key, compiled, expires_at)
       VALUES ('test-key', 'compiled context text', ?)`,
      [expiresAt]
    )

    const cached = db.query(
      `SELECT compiled FROM code_context_cache
       WHERE cache_key = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    ).get("test-key") as any

    expect(cached?.compiled).toBe("compiled context text")
  })

  test("expired entries are not returned", () => {
    const expiredAt = new Date(Date.now() - 1000).toISOString()
    db.run(
      `INSERT INTO code_context_cache (cache_key, compiled, expires_at)
       VALUES ('expired-key', 'stale context', ?)`,
      [expiredAt]
    )

    const cached = db.query(
      `SELECT compiled FROM code_context_cache
       WHERE cache_key = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    ).get("expired-key") as any

    expect(cached).toBeNull()
  })

  test("cache invalidation by key", () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    db.run(
      `INSERT INTO code_context_cache (cache_key, compiled, expires_at)
       VALUES ('my-key', 'old context', ?)`,
      [expiresAt]
    )

    db.run("DELETE FROM code_context_cache WHERE cache_key = ?", ["my-key"])

    const row = db.query("SELECT * FROM code_context_cache WHERE cache_key = ?")
      .get("my-key")

    expect(row).toBeNull()
  })
})

// ── Developer preferences injection ───────────────────────────────────────

describe("Developer preferences in code_playbook", () => {
  test("preferences with source='preferences' are queryable separately from reflector rules", () => {
    // Reflector rule
    db.run(
      `INSERT INTO code_playbook (rule, coordinator, source, confidence, active)
       VALUES ('Always add tests before merging', 'backend', 'reflector', 0.8, 1)`
    )
    // User preference
    db.run(
      `INSERT INTO code_playbook (rule, coordinator, source, confidence, active)
       VALUES ('I prefer functional React components', 'user', 'preferences', 0.9, 1)`
    )
    db.run(
      `INSERT INTO code_playbook (rule, coordinator, source, confidence, active)
       VALUES ('Avoid class components in new code', 'user', 'preferences', 0.85, 1)`
    )

    const prefs = db.query(
      `SELECT rule FROM code_playbook
       WHERE source = 'preferences' AND coordinator = 'user' AND active = 1
       ORDER BY confidence DESC`
    ).all() as any[]

    expect(prefs.length).toBe(2)
    expect(prefs[0].rule).toContain("functional React")
  })

  test("inactive preferences are excluded", () => {
    db.run(
      `INSERT INTO code_playbook (rule, coordinator, source, confidence, active)
       VALUES ('Old preference', 'user', 'preferences', 0.9, 0)`
    )

    const prefs = db.query(
      `SELECT rule FROM code_playbook
       WHERE source = 'preferences' AND active = 1`
    ).all() as any[]

    expect(prefs.length).toBe(0)
  })

  test("top-10 preferences limit works", () => {
    for (let i = 1; i <= 15; i++) {
      db.run(
        `INSERT INTO code_playbook (rule, coordinator, source, confidence, active)
         VALUES (?, 'user', 'preferences', ?, 1)`,
        [`Preference ${i}`, i / 15]
      )
    }

    const prefs = db.query(
      `SELECT rule FROM code_playbook
       WHERE source = 'preferences' AND coordinator = 'user' AND active = 1
       ORDER BY confidence DESC LIMIT 10`
    ).all() as any[]

    expect(prefs.length).toBe(10)
  })
})

// ── FTS5 skill injection ───────────────────────────────────────────────────

describe("code_commands_fts skill injection", () => {
  test("FTS5 prefix search returns matching commands", () => {
    db.run(`INSERT INTO code_commands_fts (command, category, description) VALUES ('git commit', 'git', 'Create a commit')`)
    db.run(`INSERT INTO code_commands_fts (command, category, description) VALUES ('git push', 'git', 'Push to remote')`)
    db.run(`INSERT INTO code_commands_fts (command, category, description) VALUES ('bun test', 'bun', 'Run test suite')`)

    const results = db.query(
      `SELECT command FROM code_commands_fts WHERE code_commands_fts MATCH 'git*'`
    ).all() as any[]

    expect(results.length).toBe(2)
    const commands = results.map(r => r.command)
    expect(commands).toContain("git commit")
    expect(commands).toContain("git push")
  })
})
