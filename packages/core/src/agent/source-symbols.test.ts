import { describe, expect, test } from "bun:test"
import { extractSymbols } from "./source-symbols"

const ts = [
  "import x from './x'",            // 1
  "",                                // 2
  "/** Adds. */",                    // 3
  "export function add(a: number, b: number) {", // 4
  "  const sum = a + b",             // 5
  "  return sum",                    // 6
  "}",                               // 7
  "",                                // 8
  "// the store",                    // 9
  "export class Store {",            // 10
  "  private items = []",            // 11
  "  async load(id: string) {",      // 12
  "    if (id) { return 1 }",        // 13
  "  }",                             // 14
  "  get size() {",                  // 15
  "    return 0",                    // 16
  "  }",                             // 17
  "}",                               // 18
  "",                                // 19
  "export const LIMIT = 10",         // 20
  "type Id = string",                // 21
].join("\n")

describe("extractSymbols", () => {
  const symbols = extractSymbols(ts, "ts")
  const by = (name: string) => symbols.find(s => s.name === name)

  test("finds top-level declarations only, never a local const", () => {
    expect(symbols.map(s => s.name)).toEqual(["add", "Store", "Store.load", "Store.size", "LIMIT", "Id"])
  })

  test("ranges stop before the next sibling and drop trailing comments", () => {
    expect([by("add")!.startLine, by("add")!.endLine]).toEqual([4, 7])
    expect([by("Store")!.startLine, by("Store")!.endLine]).toEqual([10, 18])
    expect([by("Store.load")!.startLine, by("Store.load")!.endLine]).toEqual([12, 14])
  })

  test("keeps exported and the signature", () => {
    expect(by("add")!.exported).toBe(true)
    expect(by("Id")!.exported).toBe(false)
    expect(by("add")!.signature).toBe("export function add(a: number, b: number)")
  })

  test("control flow inside a method is not a method", () => {
    expect(symbols.some(s => s.name === "Store.if")).toBe(false)
  })

  test("reads rust items at the top level", () => {
    const rs = ["pub struct Office {}", "", "impl Office {", "    pub fn run(&self) {}", "}", "pub fn render() {", "}"].join("\n")
    expect(extractSymbols(rs, "rs").map(s => `${s.kind}:${s.name}`)).toEqual(["struct:Office", "impl:Office", "fn:render"])
  })
})
