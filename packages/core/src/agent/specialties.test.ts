import { describe, expect, test } from "bun:test"
import { selectSpecialty } from "./specialties"

describe("selectSpecialty with a requested specialty", () => {
  test("accepts the bare id", () => {
    expect(selectSpecialty("scout", "x", "repository")?.id).toBe("repository")
  })

  test("accepts the worker/specialty form the models tend to write", () => {
    expect(selectSpecialty("scout", "x", "scout/repository")?.id).toBe("repository")
    expect(selectSpecialty("builder", "x", " Builder/Backend ")?.id).toBe("backend")
  })

  test("rejects a specialty owned by another worker and lists the valid ones", () => {
    expect(() => selectSpecialty("scout", "x", "backend")).toThrow(/Valid specialties: repository/)
  })
})
