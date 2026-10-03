/**
 * Stuck-loop and stall detection.
 *
 * The two detections are deliberately different failures. A loop is loud: same
 * call, same arguments, an error every time. A stall is silent — nothing
 * repeats, nothing errors, and the run still spends its whole budget. The stall
 * tests below are the ones that matter, because nothing else in the harness
 * would catch it.
 */
import { describe, expect, test, beforeEach } from "bun:test"
import {
  StuckLoopDetector,
  createStuckLoopDetector,
  getInterventionMessage,
} from "@johpaz/hivecode-core/agent/stuck-loop"

let detector: StuckLoopDetector
const SESSION = "s1"

beforeEach(() => {
  detector = createStuckLoopDetector()
})

describe("loop detection", () => {
  test("an empty session is not stuck", () => {
    expect(detector.check(SESSION).detected).toBe(false)
  })

  test("two identical failures are not yet a loop", () => {
    detector.recordToolCall(SESSION, "fs_write", { path: "a" }, "permission denied")
    detector.recordToolCall(SESSION, "fs_write", { path: "a" }, "permission denied")
    expect(detector.check(SESSION).detected).toBe(false)
  })

  test("three identical failures trip it", () => {
    for (let i = 0; i < 3; i++) {
      detector.recordToolCall(SESSION, "fs_write", { path: "a" }, "permission denied")
    }
    const state = detector.check(SESSION)
    expect(state.detected).toBe(true)
    expect(state.kind).toBe("loop")
    expect(state.toolName).toBe("fs_write")
    expect(state.count).toBe(3)
    expect(state.lastError).toContain("permission denied")
  })

  test("different arguments are not the same stuck call", () => {
    detector.recordToolCall(SESSION, "fs_write", { path: "a" }, "denied")
    detector.recordToolCall(SESSION, "fs_write", { path: "b" }, "denied")
    detector.recordToolCall(SESSION, "fs_write", { path: "c" }, "denied")
    expect(detector.check(SESSION).detected).toBe(false)
  })

  test("repeats without an error are not a stuck loop", () => {
    // Idempotent reads are legitimately called repeatedly.
    for (let i = 0; i < 5; i++) detector.recordToolCall(SESSION, "fs_read", { path: "a" })
    expect(detector.check(SESSION).detected).toBe(false)
  })

  test("an old resolved failure no longer counts", () => {
    for (let i = 0; i < 3; i++) {
      detector.recordToolCall(SESSION, "fs_write", { path: "a" }, "denied")
    }
    expect(detector.check(SESSION).detected).toBe(true)
    // The window only looks at the recent tail, so a success clears it.
    for (let i = 0; i < 10; i++) {
      detector.recordToolCall(SESSION, "fs_read", { path: `f${i}` })
    }
    expect(detector.check(SESSION).detected).toBe(false)
  })

  test("sessions do not bleed into each other", () => {
    for (let i = 0; i < 3; i++) {
      detector.recordToolCall("a", "fs_write", { p: 1 }, "denied")
    }
    expect(detector.check("a").detected).toBe(true)
    expect(detector.check("b").detected).toBe(false)
  })
})

describe("stall detection", () => {
  test("identical progress snapshots trip it", () => {
    for (let i = 0; i < 3; i++) detector.recordProgress(SESSION, "same")
    const state = detector.checkProgress(SESSION)
    expect(state.detected).toBe(true)
    expect(state.kind).toBe("stall")
    expect(state.toolName).toBe("NO_PROGRESS")
  })

  test("any change counts as progress", () => {
    detector.recordProgress(SESSION, "a")
    detector.recordProgress(SESSION, "b")
    detector.recordProgress(SESSION, "a")
    expect(detector.checkProgress(SESSION).detected).toBe(false)
  })

  test("a run that keeps advancing never stalls", () => {
    for (let i = 0; i < 20; i++) detector.recordProgress(SESSION, `step-${i}`)
    expect(detector.checkProgress(SESSION).detected).toBe(false)
  })

  test("the threshold is configurable", () => {
    for (let i = 0; i < 2; i++) detector.recordProgress(SESSION, "same")
    expect(detector.checkProgress(SESSION, 3).detected).toBe(false)
    expect(detector.checkProgress(SESSION, 2).detected).toBe(true)
  })

  test("too few samples is not a stall", () => {
    detector.recordProgress(SESSION, "same")
    expect(detector.checkProgress(SESSION).detected).toBe(false)
  })
})

describe("intervention messages", () => {
  test("nothing detected means nothing to say", () => {
    expect(getInterventionMessage({ detected: false, toolName: "", count: 0, kind: "loop" })).toBe("")
  })

  test("a loop at the threshold warns", () => {
    const msg = getInterventionMessage({
      detected: true, toolName: "fs_write", count: 3, lastError: "denied", kind: "loop",
    })
    expect(msg).toContain("WARNING")
    expect(msg).toContain("fs_write")
    expect(msg).not.toContain("CRITICAL")
  })

  test("a loop at four escalates to critical and quotes the error", () => {
    const msg = getInterventionMessage({
      detected: true, toolName: "fs_write", count: 4, lastError: "permission denied", kind: "loop",
    })
    expect(msg).toContain("CRITICAL")
    expect(msg).toContain("permission denied")
  })

  test("a stall tells the model to change approach, not to retry", () => {
    const msg = getInterventionMessage({ detected: true, toolName: "NO_PROGRESS", count: 3, kind: "stall" })
    expect(msg).toContain("WARNING")
    expect(msg).toContain("3")
  })
})

describe("bounded memory", () => {
  test("history per session is capped", () => {
    for (let i = 0; i < 200; i++) {
      detector.recordToolCall(SESSION, "fs_write", { i }, "denied")
    }
    // Oldest entries were dropped, so the recent tail no longer holds 3 of the
    // same failing call.
    expect(detector.check(SESSION).detected).toBe(false)
  })

  test("prune drops sessions nobody has touched", () => {
    // Same call three times: different arguments would be three separate keys.
    for (let i = 0; i < 3; i++) {
      detector.recordToolCall("old", "fs_write", { path: "a" }, "denied")
    }
    expect(detector.check("old").detected).toBe(true)
    expect(detector.prune(0)).toBe(1)
    expect(detector.check("old").detected).toBe(false)
  })

  test("prune leaves live sessions alone", () => {
    detector.recordToolCall("live", "fs_read", {})
    expect(detector.prune(30 * 60 * 1000)).toBe(0)
  })

  test("clear removes a session", () => {
    for (let i = 0; i < 3; i++) {
      detector.recordToolCall(SESSION, "fs_write", { i }, "denied")
    }
    detector.clear(SESSION)
    expect(detector.check(SESSION).detected).toBe(false)
    expect(detector.checkProgress(SESSION).detected).toBe(false)
  })
})