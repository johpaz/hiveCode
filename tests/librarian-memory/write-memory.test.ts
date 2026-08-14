/**
 * Regression tests for the Librarian's project-memory pipeline (Capa 4).
 *
 * Before the fix, the Librarian's `write_memory` tool did not exist: its prompt
 * told the LLM to call `write_memory`, but only the shared `memory_write` tool
 * was wired — and that one writes free-form notes into `scratchpad`, while the
 * CoordinatorManager injects "PROJECT MEMORY" from `agentMemory`. The result was
 * that distilled knowledge never reached future sessions. These tests pin the
 * fixed contract: `write_memory` stores typed records in `agentMemory`, scoped to
 * the project, without touching the shared `scratchpad`.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import type { AgentMemoryDoc, ScratchpadDoc } from "@johpaz/hivecode-core/storage/collections"
import { writeMemoryTool } from "@johpaz/hivecode-core/tools/agents"

type MemoryResult = { ok: boolean; confirmed_count?: number; error?: string }
const runWriteMemory = (params: Record<string, unknown>) =>
  writeMemoryTool.execute(params) as Promise<MemoryResult>

const previousHiveDbPath = process.env.HIVE_DB_PATH

beforeEach(() => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-libmem-")), "hivedb")
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

describe("write_memory (Librarian project memory)", () => {
  test("stores a typed record in agentMemory, not scratchpad", async () => {
    const res = await runWriteMemory({
      type: "pattern",
      content: "Las búsquedas persistentes usan colecciones e índices HiveDB",
      severity: "high",
      confidence: 0.8,
    })
    expect(res.ok).toBe(true)

    const rows = await (await col<AgentMemoryDoc>("agentMemory")).scan()
    expect(rows).toHaveLength(1)
    const doc = rows[0].doc
    expect(doc.type).toBe("pattern")
    expect(doc.project_id).toBe(process.cwd()) // matches the CoordinatorManager injection filter
    expect(doc.confirmed_count).toBe(1)
    expect(doc.refuted_count).toBe(0)
    expect(doc.deprecated).toBe(false)

    // The shared scratchpad-backed `memory_write` must be untouched.
    expect(await (await col<ScratchpadDoc>("scratchpad")).scan()).toHaveLength(0)
  })

  test("re-distilling the same fact bumps confirmed_count instead of duplicating", async () => {
    const content = "El endpoint /auth/refresh devuelve { accessToken, refreshToken }"
    await runWriteMemory({ type: "contract", content })
    const res = await runWriteMemory({ type: "contract", content })

    expect(res.confirmed_count).toBe(2)
    expect(await (await col<AgentMemoryDoc>("agentMemory")).scan()).toHaveLength(1)
  })

  test("rejects an unknown memory type", async () => {
    const res = await runWriteMemory({ type: "bogus", content: "x" })
    expect(res.ok).toBe(false)
    expect(await (await col<AgentMemoryDoc>("agentMemory")).scan()).toHaveLength(0)
  })
})
