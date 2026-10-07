/**
 * Document identity — `storage/ids`.
 *
 * The rule this pins: a UUIDv7 leads with a 48-bit millisecond timestamp, so its
 * FIRST 8 hex characters are identical for every document created inside the
 * same ~65 second window. Since people start documents back to back, a chip
 * taken from the head is not an identifier — it names a whole window. Only the
 * random tail is one.
 *
 * And the resolver that reads a chip back must refuse to guess: its callers are
 * `cancel` / `rollback` / `resume`, where "the first of several matches" acts on
 * the wrong document.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { formatIdCandidates, resolveIdFragment, shortId } from "@johpaz/hivecode-core/storage/ids"
import type { CodeTaskDoc } from "@johpaz/hivecode-core/storage/collections"

const previousHiveDbPath = process.env.HIVE_DB_PATH

beforeEach(() => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-ids-")), "hivedb")
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

let counter = 0
async function seedTask(description: string): Promise<string> {
  counter++
  const id = Bun.randomUUIDv7()
  const tasks = await col<CodeTaskDoc>("codeTasks")
  await tasks.put(id, {
    id, session_id: "s", task_id: id, description, status: "running", mode: "auto",
    branch_name: null, pr_url: null, tokens_in: 0, tokens_out: 0,
    files_changed: 0, lines_added: 0, lines_removed: 0, duration_ms: 0,
    created_at: new Date().toISOString(), completed_at: null,
  } as unknown as CodeTaskDoc)
  return id
}

describe("shortId", () => {
  test("is the random tail, not the timestamp head", () => {
    const id = Bun.randomUUIDv7()
    expect(shortId(id)).toBe(id.slice(-8))
  })

  test("two documents created together share the head but not the tail", async () => {
    const first = await seedTask("primera")
    const second = await seedTask("segunda")

    // The premise. If a future id scheme fixes this, this assertion is what
    // tells us the head became safe again.
    expect(first.slice(0, 8)).toBe(second.slice(0, 8))
    expect(shortId(first)).not.toBe(shortId(second))
  })
})

describe("resolveIdFragment", () => {
  test("a full id resolves exactly", async () => {
    const id = await seedTask("tarea")
    const result = await resolveIdFragment<CodeTaskDoc>("codeTasks", id)

    expect(result.kind).toBe("hit")
    if (result.kind === "hit") expect(result.match.doc.description).toBe("tarea")
  })

  test("the short id shown in listings resolves to exactly one task", async () => {
    const first = await seedTask("primera")
    const second = await seedTask("segunda")

    const result = await resolveIdFragment<CodeTaskDoc>("codeTasks", shortId(second))

    expect(result.kind).toBe("hit")
    if (result.kind === "hit") expect(result.match.id).toBe(second)
    expect(shortId(first)).not.toBe(shortId(second))
  })

  test("the ambiguous leading prefix is refused, not guessed", async () => {
    const first = await seedTask("primera")
    const second = await seedTask("segunda")
    const shared = first.slice(0, 8)

    const result = await resolveIdFragment<CodeTaskDoc>("codeTasks", shared)

    expect(result.kind).toBe("ambiguous")
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((c) => c.id).sort()).toEqual([first, second].sort())
    }
  })

  test("a fragment that is one task's tail and another's head is ambiguous", async () => {
    // Forged so the fragment is this id's HEAD while it is `first`'s TAIL.
    const first = await seedTask("primera")
    const fragment = first.slice(-8)
    const second = `${fragment}-9999-8888-7777-666655554444`
    const tasks = await col<CodeTaskDoc>("codeTasks")
    await tasks.put(second, { id: second, description: "forjada" } as unknown as CodeTaskDoc)

    const result = await resolveIdFragment<CodeTaskDoc>("codeTasks", fragment)

    // One matches by tail, the other by head — so neither wins by priority.
    expect(result.kind).toBe("ambiguous")
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((c) => c.id).sort()).toEqual([first, second].sort())
    }
  })

  test("an unknown fragment reports none", async () => {
    await seedTask("tarea")
    expect((await resolveIdFragment<CodeTaskDoc>("codeTasks", "nada-de-esto")).kind).toBe("none")
  })

  test("an empty fragment matches nothing instead of everything", async () => {
    await seedTask("una")
    await seedTask("dos")

    expect((await resolveIdFragment<CodeTaskDoc>("codeTasks", "   ")).kind).toBe("none")
  })
})

describe("formatIdCandidates", () => {
  test("lists the short id and label, one per line", () => {
    const rendered = formatIdCandidates([
      { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", label: "arregla el login" },
      { id: "11111111-2222-3333-4444-555555555555", label: "migra el esquema" },
    ])

    expect(rendered.split("\n")).toEqual([
      "  eeeeeeee  arregla el login",
      "  55555555  migra el esquema",
    ])
  })
})