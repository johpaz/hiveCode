import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pruneSandboxHomes } from "./index"

const root = mkdtempSync(join(tmpdir(), "sandbox-homes-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const HOUR = 3_600_000
const home = (name: string, ageMs: number, now: number) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  utimesSync(dir, (now - ageMs) / 1000, (now - ageMs) / 1000)
  return dir
}

describe("pruneSandboxHomes", () => {
  test("removes the homes nobody used for the TTL, keeps the recent ones and the one in use", () => {
    const now = Date.now()
    const stale = home("stale", 7 * HOUR, now)
    const recent = home("recent", 1 * HOUR, now)
    const inUse = home("in-use", 30 * HOUR, now) // old, but it is the one being used right now
    expect(pruneSandboxHomes(root, { keep: inUse, ttlMs: 6 * HOUR, now })).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(inUse)).toBe(true)
  })

  test("a missing root is nothing to prune, not an error", () => {
    expect(pruneSandboxHomes(join(root, "does-not-exist"))).toBe(0)
  })
})
