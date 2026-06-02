/**
 * Unit tests for code-indexer FTS5 synchronization.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { getTestDb, cleanupTestDb } from "../helpers/setup-db"
import {
  buildFullIndex,
  updateFileIndex,
  reconcileCodeIndex,
  getDependencies,
  getDependents,
} from "../../src/agent/code-indexer"
import { searchCode, getModuleContext } from "../../src/agent/context-retriever"

let tmpWorkspace: string
let sessionId: string

describe("code-indexer + code_fts", () => {
  beforeAll(() => {
    getTestDb()
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-indexer-test-"))
    sessionId = `test-session-${Date.now()}`

    // Seed session
    const db = getTestDb()
    db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(
      sessionId,
      tmpWorkspace,
    )

    // Create sample files
    fs.mkdirSync(path.join(tmpWorkspace, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(tmpWorkspace, "src", "utils.ts"),
      `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n\nexport class Greeter {\n  sayHello() { return "hi"; }\n}\n`,
    )
    fs.writeFileSync(
      path.join(tmpWorkspace, "src", "main.ts"),
      `import { greet, Greeter } from "./utils";\n\nexport function main() {\n  console.log(greet("world"));\n  const g = new Greeter();\n}\n`,
    )
  })

  afterAll(() => {
    cleanupTestDb()
    if (fs.existsSync(tmpWorkspace)) {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true })
    }
  })

  test("buildFullIndex populates code_graph and code_fts", async () => {
    const result = await buildFullIndex(sessionId, tmpWorkspace)
    expect(result.indexed).toBe(2)
    expect(result.skipped).toBe(0)

    const db = getTestDb()
    const graphRows = db.query(
      "SELECT file_path FROM code_graph WHERE session_id = ? ORDER BY file_path"
    ).all(sessionId) as Array<{ file_path: string }>
    expect(graphRows.length).toBe(2)

    const ftsRows = db.query(
      "SELECT file_path FROM code_fts WHERE session_id = ? ORDER BY file_path"
    ).all(sessionId) as Array<{ file_path: string }>
    expect(ftsRows.length).toBe(2)
  })

  test("searchCode finds files by function name", () => {
    const results = searchCode(sessionId, "greet")
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some(r => r.filePath.includes("utils.ts"))).toBe(true)
  })

  test("searchCode finds files by class name", () => {
    const results = searchCode(sessionId, "Greeter")
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some(r => r.filePath.includes("utils.ts"))).toBe(true)
  })

  test("getModuleContext returns rich context", () => {
    const utilsPath = path.join(tmpWorkspace, "src", "utils.ts")
    const ctx = getModuleContext(sessionId, utilsPath)
    expect(ctx).not.toBeNull()
    expect(ctx!.filePath).toBe(utilsPath)
    expect(ctx!.functions).toContain("greet")
    expect(ctx!.classes).toContain("Greeter")
    expect(ctx!.imports.length).toBe(0)
  })

  test("updateFileIndex syncs code_fts after edit", async () => {
    const mainPath = path.join(tmpWorkspace, "src", "main.ts")
    fs.writeFileSync(
      mainPath,
      `import { greet, Greeter } from "./utils";\n\nexport function main() {\n  console.log(greet("universe"));\n  const g = new Greeter();\n  g.sayHello();\n}\n\nexport function extraHelper() { return 42; }\n`,
    )

    await updateFileIndex(sessionId, mainPath, tmpWorkspace)

    const results = searchCode(sessionId, "extraHelper")
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some(r => r.filePath.includes("main.ts"))).toBe(true)
  })

  test("reconcileCodeIndex detects stale files", async () => {
    // Touch a file to make it newer
    const utilsPath = path.join(tmpWorkspace, "src", "utils.ts")
    fs.writeFileSync(
      utilsPath,
      `export function greet(name: string): string {\n  return \`Hola, \${name}!\`;\n}\n\nexport class Greeter {\n  sayHello() { return "hola"; }\n}\n`,
    )

    // Simulate that DB thinks file is older by backdating last_modified
    const db = getTestDb()
    db.query(
      "UPDATE code_graph SET last_modified = ? WHERE session_id = ? AND file_path = ?"
    ).run(
      new Date(Date.now() - 60000).toISOString(),
      sessionId,
      utilsPath,
    )

    const result = await reconcileCodeIndex(sessionId, tmpWorkspace)
    expect(result.reindexed).toBeGreaterThanOrEqual(1)

    const results = searchCode(sessionId, "Hola")
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  test("reconcileCodeIndex removes deleted files", async () => {
    const orphanPath = path.join(tmpWorkspace, "src", "orphan.ts")
    fs.writeFileSync(orphanPath, `export function orphan() {}`)
    await updateFileIndex(sessionId, orphanPath, tmpWorkspace)

    // Verify it exists
    expect(searchCode(sessionId, "orphan").length).toBeGreaterThanOrEqual(1)

    // Delete the file
    fs.unlinkSync(orphanPath)
    const result = await reconcileCodeIndex(sessionId, tmpWorkspace)
    expect(result.removed).toBeGreaterThanOrEqual(1)

    // Verify it's gone
    expect(searchCode(sessionId, "orphan").length).toBe(0)
  })
})
