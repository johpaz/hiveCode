import { describe, expect, test } from "bun:test"
import { omittedAtStart } from "./loadout"

describe("omittedAtStart", () => {
  test("readers lose the tree-walking tools once the project is indexed", () => {
    expect(omittedAtStart("scout", true, {})).toEqual(["fs_list", "fs_glob"])
    expect(omittedAtStart("planner", true, {})).toEqual(["fs_list", "fs_glob"])
  })

  test("without an index they keep everything", () => {
    expect(omittedAtStart("scout", false, {})).toEqual([])
  })

  test("writers and the coordinator are untouched", () => {
    for (const type of ["builder", "verifier", "spider", "bee", undefined]) expect(omittedAtStart(type, true, {})).toEqual([])
  })

  test("HIVECODE_READER_DISK_WALK=1 gives the listing tools back", () => {
    expect(omittedAtStart("scout", true, { HIVECODE_READER_DISK_WALK: "1" })).toEqual([])
  })
})
