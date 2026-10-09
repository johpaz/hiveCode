import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fsListTool } from "./fs-list.ts"
import { fsReadTool } from "./fs-read.ts"

let root: string
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-bounds-"))
  fs.mkdirSync(path.join(root, "node_modules/dep"), { recursive: true })
  fs.writeFileSync(path.join(root, "node_modules/dep/index.js"), "x")
  fs.mkdirSync(path.join(root, "src"))
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(root, "src", `f${i}.ts`), "")
  fs.writeFileSync(path.join(root, "minified.js"), "a".repeat(100_000))
  fs.writeFileSync(path.join(root, "many.txt"), Array.from({ length: 400 }, (_, i) => `linea ${i} ${"y".repeat(100)}`).join("\n"))
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe("fs_list", () => {
  test("skips dependency directories and says so", async () => {
    const out: any = await fsListTool.execute({ path: root, recursive: true }, { configurable: { workspace: root } })
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out.entries)).not.toContain("node_modules")
    expect(out.truncated).toBe(true)
  })

  test("caps the entries across the whole tree", async () => {
    const out: any = await fsListTool.execute({ path: root, recursive: true }, { configurable: { workspace: root } })
    expect(out.count).toBeLessThanOrEqual(200)
    expect(out.note).toContain("omitieron")
  })

  test("names and types only unless detail is asked for", async () => {
    const plain: any = await fsListTool.execute({ path: root }, { configurable: { workspace: root } })
    expect(plain.entries.every((e: any) => e.size === undefined && e.modified === undefined)).toBe(true)
    const detailed: any = await fsListTool.execute({ path: root, detail: true }, { configurable: { workspace: root } })
    expect(detailed.entries.some((e: any) => typeof e.size === "number")).toBe(true)
  })
})

describe("fs_read", () => {
  test("cuts a long read by characters and says where to continue", async () => {
    const out: any = await fsReadTool.execute({ path: path.join(root, "many.txt"), offset: 1, limit: 400 }, { configurable: { workspace: root } })
    expect(out.ok).toBe(true)
    expect(out.truncated).toBe(true)
    expect(out.content.length).toBeLessThan(21_000)
    expect(out.nextOffset).toBe(out.linesRead + 1)
  })

  test("clips a single enormous line", async () => {
    const out: any = await fsReadTool.execute({ path: path.join(root, "minified.js"), offset: 1, limit: 1 }, { configurable: { workspace: root } })
    expect(out.content.length).toBeLessThan(21_000)
    expect(out.content).toContain("recortada")
  })
})
