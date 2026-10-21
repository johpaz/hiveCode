import { describe, expect, test } from "bun:test"
import { chargeCapabilitySearch, endDiscovery, isCapabilitySearch, MAX_CAPABILITY_SEARCHES } from "./discovery-budget"

describe("discovery budget", () => {
  test("only searches for capabilities count, not code", () => {
    expect(isCapabilitySearch("search_knowledge", { type: "tools", query: "x" })).toBe(true)
    expect(isCapabilitySearch("search_knowledge", '{"query":"x"}')).toBe(true)
    expect(isCapabilitySearch("search_knowledge", { type: "code", query: "x" })).toBe(false)
    expect(isCapabilitySearch("search_knowledge", '{"type":"code"}')).toBe(false)
    expect(isCapabilitySearch("fs_read", { type: "tools" })).toBe(false)
  })

  test("a run gets its few searches and then no more, per run", () => {
    for (let i = 0; i < MAX_CAPABILITY_SEARCHES; i++) expect(chargeCapabilitySearch("run-a")).toBe(true)
    expect(chargeCapabilitySearch("run-a")).toBe(false)
    expect(chargeCapabilitySearch("run-b")).toBe(true)
    endDiscovery("run-a")
    expect(chargeCapabilitySearch("run-a")).toBe(true)
  })
})
