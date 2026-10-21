import { describe, expect, test } from "bun:test"
import { clearTaskBudget, recordTaskUsage, setTaskBudget, taskBudgetBlocker, taskBudgetUsage } from "./task-budget"

describe("task budget", () => {
  test("is shared by every run that reports the same task", () => {
    setTaskBudget("t1", { maxInputTokens: 1_000, maxOutputTokens: 0 })
    recordTaskUsage("t1", 400, 50) // BEE
    recordTaskUsage("t1", 500, 50) // a worker
    expect(taskBudgetBlocker("t1")).toBeUndefined()
    recordTaskUsage("t1", 100, 0)
    expect(taskBudgetBlocker("t1")).toBe("task_input_tokens:1000")
    clearTaskBudget("t1")
  })

  test("output tokens are bounded too, and 0 means no limit", () => {
    setTaskBudget("t2", { maxInputTokens: 0, maxOutputTokens: 100 })
    recordTaskUsage("t2", 9_000_000, 99)
    expect(taskBudgetBlocker("t2")).toBeUndefined()
    recordTaskUsage("t2", 0, 1)
    expect(taskBudgetBlocker("t2")).toBe("task_output_tokens:100")
    clearTaskBudget("t2")
  })

  test("a task without a budget is never blocked, and clearing reports the spend", () => {
    recordTaskUsage("nobody", 5, 5)
    recordTaskUsage(undefined, 5, 5)
    expect(taskBudgetBlocker("nobody")).toBeUndefined()
    expect(taskBudgetBlocker(undefined)).toBeUndefined()

    setTaskBudget("t3", { maxInputTokens: 10, maxOutputTokens: 10 })
    recordTaskUsage("t3", 3, 2)
    expect(taskBudgetUsage("t3")).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(clearTaskBudget("t3")).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(taskBudgetBlocker("t3")).toBeUndefined()
  })
})
