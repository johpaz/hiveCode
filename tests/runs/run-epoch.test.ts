/**
 * Run epochs — the requalification boundary.
 *
 * "fs_read has been failing lately" is only a claim if the failures happened
 * under the conditions the reader assumes. Change the model or the tool catalog
 * mid-window and the claim stops meaning anything. These tests pin both halves:
 * the epoch is computed from what it claims to be, and the boundary is detected.
 */
import { describe, expect, test } from "bun:test"
import {
  buildRunEpoch,
  formatEpochKey,
  parseEpochKey,
  commonEpochKey,
  distinctEpochKeys,
} from "@johpaz/hivecode-core/agent/run-epoch"

const base = { provider: "openai", model: "gpt-4o-mini" }

describe("buildRunEpoch", () => {
  test("captures provider, model and app version", () => {
    const epoch = buildRunEpoch({ ...base, toolNames: ["fs_read"] })
    expect(epoch.provider).toBe("openai")
    expect(epoch.model).toBe("gpt-4o-mini")
    expect(epoch.app_version).toBeTruthy()
  })

  test("the tool catalog hash does not depend on order", () => {
    const a = buildRunEpoch({ ...base, toolNames: ["fs_read", "fs_write", "notify"] })
    const b = buildRunEpoch({ ...base, toolNames: ["notify", "fs_read", "fs_write"] })
    expect(a.tool_catalog_hash).toBe(b.tool_catalog_hash)
  })

  test("gaining or losing a tool changes the hash", () => {
    const before = buildRunEpoch({ ...base, toolNames: ["fs_read"] })
    const after = buildRunEpoch({ ...base, toolNames: ["fs_read", "fs_write"] })
    expect(before.tool_catalog_hash).not.toBe(after.tool_catalog_hash)
  })

  test("a different model is a different epoch", () => {
    const a = buildRunEpoch({ provider: "openai", model: "gpt-4o-mini", toolNames: [] })
    const b = buildRunEpoch({ provider: "openai", model: "gpt-4o", toolNames: [] })
    expect(formatEpochKey(a)).not.toBe(formatEpochKey(b))
  })

  test("an empty catalog still produces a stable hash", () => {
    expect(buildRunEpoch({ ...base, toolNames: [] }).tool_catalog_hash).toBe(
      buildRunEpoch({ ...base, toolNames: [] }).tool_catalog_hash,
    )
  })
})

describe("epoch key round-trip", () => {
  test("a key parses back to the same fields", () => {
    const epoch = buildRunEpoch({ ...base, toolNames: ["a", "b"] })
    const parsed = parseEpochKey(formatEpochKey(epoch))
    expect(parsed).toEqual(epoch)
  })

  test("a key with a slash in the model survives", () => {
    const epoch = buildRunEpoch({ provider: "openrouter", model: "vendor/model:v2", toolNames: [] })
    const parsed = parseEpochKey(formatEpochKey(epoch))
    expect(parsed?.provider).toBe("openrouter")
    expect(parsed?.model).toBe("vendor/model:v2")
  })

  test("garbage does not parse", () => {
    expect(parseEpochKey("nonsense")).toBeNull()
    expect(parseEpochKey("")).toBeNull()
  })
})

describe("boundary detection", () => {
  const epochA = formatEpochKey(buildRunEpoch({ ...base, toolNames: ["a"] }))
  const epochB = formatEpochKey(buildRunEpoch({ ...base, toolNames: ["a", "b"] }))

  test("a uniform batch shares one epoch", () => {
    expect(commonEpochKey([epochA, epochA, epochA])).toBe(epochA)
    expect(distinctEpochKeys([epochA, epochA]).length).toBe(1)
  })

  test("a batch straddling two epochs has no common one", () => {
    expect(commonEpochKey([epochA, epochB])).toBeUndefined()
    expect(distinctEpochKeys([epochA, epochB]).length).toBe(2)
  })

  test("an unstamped trace is not evidence the rest agree", () => {
    // Otherwise a legacy trace silently launders a mixed batch into "uniform".
    expect(commonEpochKey([epochA, epochA, null])).toBeUndefined()
  })

  test("an all-unstamped batch is not a boundary", () => {
    // Nothing to compare, so nothing is straddling.
    expect(commonEpochKey([null, null])).toBeUndefined()
    expect(distinctEpochKeys([null, null]).length).toBe(0)
  })

  test("an empty batch is not a boundary", () => {
    expect(commonEpochKey([])).toBeUndefined()
    expect(distinctEpochKeys([]).length).toBe(0)
  })

  test("a model swap alone is a boundary", () => {
    const other = formatEpochKey(buildRunEpoch({ provider: "anthropic", model: "claude", toolNames: ["a"] }))
    expect(commonEpochKey([epochA, other])).toBeUndefined()
  })
})