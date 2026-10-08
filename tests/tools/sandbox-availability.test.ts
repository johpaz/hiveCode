/**
 * The shell tool used to choose between "run unsandboxed" and "refuse" by
 * searching the error message for "falling back" / "excluded". Rewording the
 * message would have silently flipped a refusal into an unsandboxed run, so the
 * decision now rides on a typed `reason`.
 */
import { describe, expect, test } from "bun:test"
import {
  buildSandboxCommand,
  describeSandboxUnavailable,
  type SandboxConfig,
} from "../../packages/core/src/tools/cli/sandbox.ts"

const base: SandboxConfig = {
  enabled: true,
  mode: "permissions",
  workspace: "/tmp/ws",
  filesystem: { allowWrite: ["/tmp/ws"], denyWrite: [], denyRead: [], allowRead: [] },
  network: { enabled: true, allowedDomains: [] },
  excludedCommands: ["docker"],
  failIfUnavailable: false,
}

describe("sandbox skip reasons", () => {
  test("disabled sandbox reports reason=disabled", () => {
    const r = buildSandboxCommand("ls", { ...base, enabled: false })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("disabled")
  })

  test("excluded command reports reason=excluded", () => {
    const r = buildSandboxCommand("docker ps", base)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("excluded")
  })

  test("failIfUnavailable never yields a fallback reason", () => {
    const r = buildSandboxCommand("ls", { ...base, failIfUnavailable: true })
    // Either a provider exists (ok) or the result must be a hard error with no reason.
    if (!r.ok) expect(r.reason).toBeUndefined()
  })

  test("unavailable message tells the user what to do", () => {
    expect(describeSandboxUnavailable().length).toBeGreaterThan(10)
  })
})
