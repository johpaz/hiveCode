import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { measureCodeQuality } from "../../scripts/bench-code-quality"

let dir: string
const write = (file: string, text: string) => {
  mkdirSync(join(dir, file.split("/").slice(0, -1).join("/") || "."), { recursive: true })
  writeFileSync(join(dir, file), text)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "quality-"))
  write("src/a.ts", `// helper
export function f(x: number | null, items: string[]): number {
  let n = 0
  if (x && x > 1) {
    n++
  }
  for (const i of items) {
    n += i.length > 3 ? 1 : 0
  }
  return n
}

export const g = (v: any) => {
  try {
    JSON.parse(v)
  } catch {}
  console.log(v)
}
// TODO: later
`)
  write("src/b.ts", `export const bad: number = "x"\n`)
  write("tests/a.test.ts", `import { test, expect } from "bun:test"
import { f } from "../src/a"
test("one", () => { expect(f(2, ["abcd"])).toBe(2) })
test("two", () => {
  expect(f(null, [])).toBe(0)
  expect(f(1, [])).toBe(0)
})
`)
  write("package.json", JSON.stringify({ dependencies: { zod: "1" }, devDependencies: { a: "1", b: "1" } }))
  write("node_modules/dep/index.ts", "export const x: any = 1\n")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const FILES = ["src/a.ts", "src/b.ts", "tests/a.test.ts", "package.json", "node_modules/dep/index.ts"]

describe("measureCodeQuality", () => {
  test("counts what the sample project contains, and ignores installed packages", () => {
    const q = measureCodeQuality(dir, FILES)
    expect(q.srcFiles).toBe(2) // a.ts and b.ts; node_modules and the test are not source
    expect(q.testFiles).toBe(1)
    expect(q.functions).toBe(2)
    expect(q.any).toBe(1) // the one in src; the one inside node_modules is not counted
    expect(q.consoleCalls).toBe(1)
    expect(q.emptyCatch).toBe(1)
    expect(q.todo).toBe(1)
    expect(q.deps).toBe(1)
    expect(q.devDeps).toBe(2)
    expect(q.hasTsconfig).toBe(false)
  })

  test("cyclomatic complexity counts branches, conditions and loops per function", () => {
    const q = measureCodeQuality(dir, FILES)
    // f: 1 + if + && + for + ?: = 5 · g: 1 + catch = 2
    expect(q.ccMax).toBe(5)
    expect(q.ccAvg).toBe(3.5)
    expect(q.ccOver10).toBe(0)
  })

  test("tests and assertions are read from the tests the agent wrote", () => {
    const q = measureCodeQuality(dir, FILES)
    expect(q.tests).toBe(2)
    expect(q.assertions).toBe(3)
  })

  test("strict type errors are counted in the source, with Bun's types available to everybody", () => {
    const q = measureCodeQuality(dir, FILES)
    expect(q.strictErrors).toBe(1) // `const bad: number = "x"`; nothing for Bun/bun:test/any
    expect(q.testStrictErrors).toBe(0)
  })

  test("comment-only lines are told apart from code, and trailing comments do not make a line a comment", () => {
    const q = measureCodeQuality(dir, FILES)
    expect(q.commentRatio).toBeGreaterThan(0)
    expect(q.commentRatio).toBeLessThan(0.2)
    write("src/c.ts", `export const a = 1 // note\n/* block\n   comment */\nexport const b = 2\n`)
    const withComments = measureCodeQuality(dir, [...FILES, "src/c.ts"])
    expect(withComments.srcSloc - q.srcSloc).toBe(2) // two code lines; the block comment is not code
  })

  test("duplication is the share of repeated 5-line blocks", () => {
    const block = Array.from({ length: 8 }, (_, i) => `export const value${i} = compute(${i}, "constant text");`).join("\n")
    const copy = mkdtempSync(join(tmpdir(), "quality-dup-"))
    try {
      mkdirSync(join(copy, "src"), { recursive: true })
      writeFileSync(join(copy, "src/x.ts"), block)
      writeFileSync(join(copy, "src/y.ts"), block)
      const twice = measureCodeQuality(copy, ["src/x.ts", "src/y.ts"])
      const once = measureCodeQuality(copy, ["src/x.ts"])
      expect(once.dupRatio).toBe(0)
      expect(twice.dupRatio).toBeGreaterThan(0.9)
    } finally { rmSync(copy, { recursive: true, force: true }) }
  })

  test("an empty project is all zeros, not a crash", () => {
    const empty = mkdtempSync(join(tmpdir(), "quality-empty-"))
    try {
      const q = measureCodeQuality(empty, [])
      expect(q.srcFiles).toBe(0)
      expect(q.functions).toBe(0)
      expect(q.strictErrors).toBe(0)
      expect(q.dupRatio).toBe(0)
    } finally { rmSync(empty, { recursive: true, force: true }) }
  })
})
