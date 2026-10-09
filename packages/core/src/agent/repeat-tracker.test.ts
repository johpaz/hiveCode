import { describe, expect, test } from "bun:test"
import { RepeatTracker } from "./agent-loop.ts"

/** One model step = one batch of calls recorded between two nextStep() calls. */
function step(tracker: RepeatTracker, calls: Array<[string, string]>) {
  tracker.nextStep()
  return calls.map(([tool, sig]) => tracker.record(tool, sig))
}

describe("RepeatTracker streak counts steps, not calls", () => {
  test("five different reads in one parallel step are not a loop", () => {
    const tracker = new RepeatTracker()
    const verdicts = step(tracker, [1, 2, 3, 4, 5].map(i => ["fs_exists", `fs_exists:{"path":"f${i}"}`]))
    expect(verdicts).toEqual(["ok", "ok", "ok", "ok", "ok"])
    expect(tracker.streakFor("fs_exists")).toBe(1)
  })

  test("the same tool for five steps in a row is still a stall", () => {
    const tracker = new RepeatTracker()
    const last: string[] = []
    for (let i = 1; i <= 5; i++) last.push(step(tracker, [["fs_glob", `fs_glob:${i}`]])[0]!)
    expect(last.slice(0, 2)).toEqual(["ok", "ok"])
    expect(last[2]).toBe("nudge")
    expect(last[4]).toBe("stop")
  })

  test("identical calls are still caught inside one step", () => {
    const tracker = new RepeatTracker()
    const verdicts = step(tracker, [["fs_read", "same"], ["fs_read", "same"], ["fs_read", "same"], ["fs_read", "same"]])
    expect(verdicts[3]).toBe("stop")
  })
})

describe("orchestration tools are exempt from the dominance rule", () => {
  test("a coordinator delegating many times in a row is not nudged or stopped", () => {
    const tracker = new RepeatTracker()
    const verdicts: string[] = []
    for (let i = 1; i <= 8; i++) verdicts.push(step(tracker, [["task_delegate", `task_delegate:t${i}`]])[0]!)
    expect(new Set(verdicts)).toEqual(new Set(["ok"]))
  })

  test("delegating the exact same task again is still flagged", () => {
    const tracker = new RepeatTracker()
    const verdicts = [1, 2, 3, 4].map(() => step(tracker, [["task_delegate", "task_delegate:same"]])[0]!)
    expect(verdicts[1]).toBe("nudge")
    expect(verdicts[3]).toBe("stop")
  })
})
