import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fsEditTool } from "./fs-edit.ts"
import { fsReadTool } from "./fs-read.ts"
import { searchInFilesTool } from "./search-in-files.ts"

let root: string
const cfg = () => ({ configurable: { workspace: root } })

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-direct-"))
  fs.mkdirSync(path.join(root, "src"))
  fs.mkdirSync(path.join(root, "node_modules/dep"), { recursive: true })
  fs.writeFileSync(path.join(root, "node_modules/dep/index.ts"), "const needle = 1")
  fs.writeFileSync(path.join(root, "src/a.ts"), "const needle = 1\nconst other = 2\n")
  fs.writeFileSync(path.join(root, "src/b.md"), "needle in docs\n")
  fs.writeFileSync(path.join(root, "big.txt"), Array.from({ length: 800 }, (_, i) => `row ${i + 1}`).join("\n"))
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe("fs_edit", () => {
  test("applies several edits to one file in a single call, in order", async () => {
    const file = path.join(root, "multi.ts")
    fs.writeFileSync(file, "alpha\nbeta\ngamma\n")
    const out: any = await fsEditTool.execute({
      path: file,
      edits: [
        { oldString: "alpha", newString: "ALPHA" },
        { oldString: "ALPHA\nbeta", newString: "ALPHA\nBETA" }, // sees the result of the first edit
        { oldString: "gamma", newString: "$&-literal" },
      ],
    }, cfg())
    expect(out.ok).toBe(true)
    expect(out.replacements).toBe(3)
    expect(fs.readFileSync(file, "utf8")).toBe("ALPHA\nBETA\n$&-literal\n")
  })

  test("is all-or-nothing: a failing edit leaves the file untouched", async () => {
    const file = path.join(root, "atomic.ts")
    fs.writeFileSync(file, "one\ntwo\n")
    const out: any = await fsEditTool.execute({
      path: file,
      edits: [
        { oldString: "one", newString: "1" },
        { oldString: "missing", newString: "x" },
      ],
    }, cfg())
    expect(out.ok).toBe(false)
    expect(out.error).toContain("edits[1]")
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\n")
  })

  test("keeps the single oldString/newString form and its ambiguity check", async () => {
    const file = path.join(root, "single.ts")
    fs.writeFileSync(file, "x x\n")
    const ambiguous: any = await fsEditTool.execute({ path: file, oldString: "x", newString: "y" }, cfg())
    expect(ambiguous.ok).toBe(false)
    const all: any = await fsEditTool.execute({ path: file, oldString: "x", newString: "y", replaceAll: true }, cfg())
    expect(all.ok).toBe(true)
    expect(all.replacements).toBe(2)
    expect(fs.readFileSync(file, "utf8")).toBe("y y\n")
  })

  test("asks for something to do when given neither form", async () => {
    const out: any = await fsEditTool.execute({ path: path.join(root, "src/a.ts") }, cfg())
    expect(out.ok).toBe(false)
  })
})

describe("fs_read on a large file", () => {
  test("returns the first lines with the way to continue, never an empty turn", async () => {
    const out: any = await fsReadTool.execute({ path: path.join(root, "big.txt") }, cfg())
    expect(out.ok).toBe(true)
    expect(out.content.startsWith("1: row 1")).toBe(true)
    expect(out.linesRead).toBe(500)
    expect(out.truncated).toBe(true)
    expect(out.nextOffset).toBe(501)
    expect(out.requiresProtocol).toBeUndefined()
  })

  test("an explicit range is untouched", async () => {
    const out: any = await fsReadTool.execute({ path: path.join(root, "big.txt"), offset: 700, limit: 5 }, cfg())
    expect(out.linesRead).toBe(5)
    expect(out.truncated).toBeUndefined()
  })
})

describe("search_in_files", () => {
  test("skips dependency directories", async () => {
    const out: any = await searchInFilesTool.execute({ pattern: "needle", path: root }, cfg())
    expect(out.ok).toBe(true)
    expect(out.matches.some((m: any) => m.file.includes("node_modules"))).toBe(false)
    expect(out.count).toBe(2)
  })

  test("glob narrows the files searched", async () => {
    const out: any = await searchInFilesTool.execute({ pattern: "needle", path: root, glob: "**/*.md" }, cfg())
    expect(out.matches.map((m: any) => path.basename(m.file))).toEqual(["b.md"])
  })

  test("context returns the surrounding lines", async () => {
    const out: any = await searchInFilesTool.execute({ pattern: "other", path: path.join(root, "src/a.ts"), context: 1 }, cfg())
    expect(out.matches[0].before).toEqual(["const needle = 1"])
  })

  test("output=files lists matching files with counts", async () => {
    const out: any = await searchInFilesTool.execute({ pattern: "needle", path: root, output: "files" }, cfg())
    expect(out.files.map((f: any) => path.basename(f.file)).sort()).toEqual(["a.ts", "b.md"])
    expect(out.files.every((f: any) => f.count === 1)).toBe(true)
  })

  test("limit caps the matches and says so", async () => {
    const out: any = await searchInFilesTool.execute({ pattern: "row", path: path.join(root, "big.txt"), limit: 3 }, cfg())
    expect(out.count).toBe(3)
    expect(out.truncated).toBe(true)
  })
})
