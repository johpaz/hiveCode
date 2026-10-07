/**
 * The README makes checkable claims about behaviour. This pins the ones that
 * are easy to drift: a command it lists must exist, and a collection it drops
 * from the tables must not come back.
 *
 * A README is not documentation if it is allowed to describe a system that no
 * longer exists — `sessions` and `messages` sat in its tables for months after
 * they lost their last writer.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8")
const commandParser = readFileSync(
  path.join(REPO_ROOT, "packages/code/src/coordinator/command-parser.ts"),
  "utf8",
)

describe("README claims", () => {
  test("every slash command the README lists is one the parser dispatches", () => {
    // The command block is the one under "Comandos internos del TUI".
    const section = readme.match(/## Comandos internos del TUI[\s\S]*?```\n([\s\S]*?)\n```/)?.[1] ?? ""
    const commands = [...section.matchAll(/^(\/[a-z][a-z-]*)/gm)].map((m) => m[1])
    expect(commands.length).toBeGreaterThan(10)

    // The parser is the source of truth for what a command does, so a command
    // the README teaches must appear in its dispatch switch.
    const missing = commands.filter((cmd) => {
      const name = cmd.slice(1)
      return !new RegExp(`case ["']${name}["']`).test(commandParser)
    })
    // Anything the README teaches that the parser cannot route is a dead command.
    expect(missing).toEqual([])
  })

  test("the collections the README lists are the ones HiveDB has", async () => {
    const tables = [...readme.matchAll(/^\| `([a-zA-Z_]+)` \|/gm)].map((m) => m[1])
    expect(tables.length).toBeGreaterThan(10)

    // Dead collections, removed once they lost their last writer.
    for (const gone of ["sessions", "messages"]) {
      expect(tables, `"${gone}" was dropped from the schema`).not.toContain(gone)
    }
  })

  test("the session model the README describes matches the code", async () => {
    const scribe = readFileSync(
      path.join(REPO_ROOT, "packages/code/src/narrative/scribe.ts"),
      "utf8",
    )
    const coordinator = readFileSync(
      path.join(REPO_ROOT, "packages/code/src/workers/coordinator-manager.ts"),
      "utf8",
    )

    // "se crea con el primer mensaje": no session is created at startup.
    expect(coordinator).not.toMatch(/openSession\(\):\s*string/)
    // "el nombre es ese pedido": the first turn stamps a title.
    expect(scribe).toContain("PROVISIONAL_TITLE_LIMIT")
    // "el id corto es la cola": every display goes through the shared helper.
    const shortId = readFileSync(
      path.join(REPO_ROOT, "packages/core/src/storage/ids.ts"),
      "utf8",
    )
    expect(shortId).toContain("return id.slice(-length)")
  })
})
