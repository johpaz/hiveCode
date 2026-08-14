/**
 * Cross-language IPC contract conformance — TypeScript (Bun) ↔ Rust (hivetui).
 *
 * The IPC protocol is declared twice:
 *   · packages/core/src/ipc/protocol.ts   → `BunMessage` / `TuiMessage` unions
 *   · packages/hivetui/src/ipc/mod.rs     → `BunMessage` / `TuiMessage` serde enums
 *
 * Nothing at compile time links them, so a type added on one side silently
 * degrades on the other: an unknown `BunMessage` deserializes to
 * `BunMessage::Unknown` (a no-op) and an unknown `TuiMessage` is dropped by
 * the Bun handler's `switch`. Both failures are invisible at runtime.
 *
 * These tests parse both sources and pin the drift to an explicit, annotated
 * allowlist. The suite fails when NEW drift appears *and* when a known gap is
 * closed — closing one requires deleting its entry here, so the list can never
 * silently rot.
 */

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { messagePriority } from "@johpaz/hivecode-core/ipc/protocol"
import type { BunMessage } from "@johpaz/hivecode-core/ipc/protocol"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const PROTOCOL_TS = path.join(REPO_ROOT, "packages/core/src/ipc/protocol.ts")
const IPC_RS = path.join(REPO_ROOT, "packages/hivetui/src/ipc/mod.rs")

const tsSource = await Bun.file(PROTOCOL_TS).text()
const rsSource = await Bun.file(IPC_RS).text()

// ── Source extraction ─────────────────────────────────────────────────────────

/** Discriminant tags of a TS discriminated union (`type: "..."` members). */
function tsUnionTags(unionName: string): Set<string> {
  const start = tsSource.indexOf(`export type ${unionName} =`)
  expect(start, `TS union ${unionName} not found in protocol.ts`).toBeGreaterThan(-1)
  const rest = tsSource.slice(start + `export type ${unionName} =`.length)
  // The union ends at the next top-level declaration.
  const end = rest.search(/\nexport (type|function|const|interface) /)
  const body = end < 0 ? rest : rest.slice(0, end)
  return new Set([...body.matchAll(/type:\s*"([a-z_]+)"/g)].map(m => m[1]!))
}

/** `#[serde(rename_all = "snake_case")]` turns `PlanUpdate` into `plan_update`. */
function pascalToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
}

/** Variant tags of a Rust `#[serde(tag = "type", rename_all = "snake_case")]` enum. */
function rustEnumTags(enumName: string): Set<string> {
  const start = rsSource.indexOf(`pub enum ${enumName} {`)
  expect(start, `Rust enum ${enumName} not found in ipc/mod.rs`).toBeGreaterThan(-1)
  const from = rsSource.slice(start)

  // Balance braces to find the end of the enum body.
  let depth = 0
  let end = -1
  for (let i = from.indexOf("{"); i < from.length; i++) {
    if (from[i] === "{") depth++
    else if (from[i] === "}") {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  expect(end, `unbalanced braces while parsing Rust enum ${enumName}`).toBeGreaterThan(-1)

  const tags = new Set<string>()
  for (const line of from.slice(0, end).split("\n")) {
    // Variants sit at exactly one indent level inside the enum body.
    const match = line.match(/^ {4}([A-Z][A-Za-z0-9]*)\s*(\{|,|$)/)
    if (match) tags.add(pascalToSnake(match[1]!))
  }
  return tags
}

const tsBun = tsUnionTags("BunMessage")
const tsTui = tsUnionTags("TuiMessage")
const rustBun = rustEnumTags("BunMessage")
const rustTui = rustEnumTags("TuiMessage")

/** `Unknown` is serde's catch-all, not a real protocol member. */
rustBun.delete("unknown")

const sortedDiff = (a: Set<string>, b: Set<string>) => [...a].filter(x => !b.has(x)).sort()

// ── Known gaps ────────────────────────────────────────────────────────────────
// Each entry is a real defect, not an accepted design. See the report in the
// task summary. Fixing one means deleting it here — the assertions below check
// the allowlist matches the drift EXACTLY, so a stale entry fails the suite.

/** Bun emits these, but Rust has no variant → deserialized as `Unknown` and dropped. */
const BUN_TYPES_MISSING_IN_RUST: string[] = []

/** Rust renders these, but the TS union has no member → emitters are untyped. */
const BUN_TYPES_MISSING_IN_TS: string[] = []

/** `tui-launcher.ts` handles these, but the Rust TUI never sends them → dead handlers. */
const TUI_TYPES_MISSING_IN_RUST: string[] = []

// ── Bun → TUI ─────────────────────────────────────────────────────────────────

describe("IPC contract: Bun → TUI (BunMessage)", () => {
  test("both sides declare a non-trivial protocol", () => {
    expect(tsBun.size).toBeGreaterThan(30)
    expect(rustBun.size).toBeGreaterThan(30)
  })

  test("every TS BunMessage type has a Rust variant, except the known gaps", () => {
    expect(sortedDiff(tsBun, rustBun)).toEqual(BUN_TYPES_MISSING_IN_RUST)
  })

  test("every Rust BunMessage variant has a TS member, except the known gaps", () => {
    expect(sortedDiff(rustBun, tsBun)).toEqual(BUN_TYPES_MISSING_IN_TS)
  })

  test("the shared core of the protocol is large and stable", () => {
    const shared = [...tsBun].filter(t => rustBun.has(t))
    expect(shared.length).toBeGreaterThanOrEqual(38)
    // Spot-check the messages that carry the main flow.
    for (const critical of [
      "init", "status", "history_append", "worker_update", "activity_update",
      "narrative_chunk", "plan_update", "task_update", "review_verdict_update",
      "file_diff", "dashboard_snapshot", "conflict_alert", "halt_state",
    ]) {
      expect(shared, `"${critical}" must exist on both sides`).toContain(critical)
    }
  })
})

// ── TUI → Bun ─────────────────────────────────────────────────────────────────

describe("IPC contract: TUI → Bun (TuiMessage)", () => {
  test("every Rust TuiMessage variant is handled by the TS union", () => {
    // Rust is the producer here — an unmatched variant is silently dropped by Bun.
    expect(sortedDiff(rustTui, tsTui)).toEqual([])
  })

  test("every TS TuiMessage member is produced by Rust, except the known gaps", () => {
    expect(sortedDiff(tsTui, rustTui)).toEqual(TUI_TYPES_MISSING_IN_RUST)
  })
})

// ── Priority routing ──────────────────────────────────────────────────────────

describe("IPC contract: priority routing", () => {
  test("messagePriority classifies every TS BunMessage type", () => {
    for (const type of tsBun) {
      const priority = messagePriority({ type } as BunMessage)
      expect(["critical", "normal", "low"], `${type} → ${priority}`).toContain(priority)
    }
  })

  test("priority sets reference only real message types", () => {
    // A typo in CRITICAL_TYPES/LOW_TYPES would silently demote a message to
    // "normal", so pin the classification of the ones that must not lag.
    for (const type of ["init", "conflict_alert", "halt_state", "review_verdict_update", "resume_available"]) {
      expect(messagePriority({ type } as BunMessage), `${type} must be critical`).toBe("critical")
    }
    for (const type of ["log_entry", "file_diff", "dashboard_snapshot", "metrics_update"]) {
      expect(messagePriority({ type } as BunMessage), `${type} must be low`).toBe("low")
    }
    for (const type of ["history_append", "status", "narrative_chunk", "worker_update"]) {
      expect(messagePriority({ type } as BunMessage), `${type} must be normal`).toBe("normal")
    }
  })

  test("critical messages Rust must render are classified critical on the TS side", () => {
    // These drive blocking UI (alerts, halts, approval gates). If any of them
    // were reclassified as "low" a flood of log entries could delay them.
    const mustBeCritical: BunMessage["type"][] = [
      "init", "conflict_alert", "conflict_resolved", "file_risk_update",
      "forensic_alert", "security_status_update", "halt_state",
      "review_verdict_update", "resume_available",
    ]
    for (const type of mustBeCritical) {
      expect(rustBun, `Rust must handle critical message "${type}"`).toContain(type)
      expect(messagePriority({ type } as BunMessage)).toBe("critical")
    }
  })
})

// ── Suspend/resume handshake ──────────────────────────────────────────────────

describe("IPC contract: suspend/resume handshake", () => {
  test("Rust can acknowledge a suspend request", () => {
    // `tui-launcher.ts` resolves `suspendTui()` only on an inbound `suspended`.
    // Without this variant every `await tuiControl.suspend()` hangs forever.
    expect(rustBun.has("suspend")).toBe(true)
    expect(rustBun.has("resume")).toBe(true)
    expect(rustTui.has("suspended")).toBe(true)
    expect(tsTui.has("suspended")).toBe(true)
  })

  test("the TUI releases and reacquires the terminal around the handshake", async () => {
    // The acknowledgement is only honest if the terminal was actually handed
    // back: raw mode off and the alternate screen left before replying.
    const appSource = await Bun.file(path.join(REPO_ROOT, "packages/hivetui/src/app.rs")).text()
    const suspendArm = appSource.slice(
      appSource.indexOf("BunMessage::Suspend =>"),
      appSource.indexOf("BunMessage::Resume =>"),
    )
    expect(suspendArm).toContain("session.leave()")
    expect(suspendArm).toContain("TuiMessage::Suspended")
    expect(appSource).toContain("fn leave(&mut self)")
    expect(appSource).toContain("fn reenter(&mut self)")
    expect(appSource.slice(appSource.indexOf("fn leave(&mut self)"))).toContain("disable_raw_mode")
  })
})
