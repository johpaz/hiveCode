import { describe, expect, test } from "bun:test"
import { clearTaskBudget, recordTaskUsage, setTaskBudget, taskBudgetBlocker } from "../agent/task-budget.ts"
import { analyzeStatement, decideTier } from "./task-weight.ts"
import { RESERVE_SHARE, ROUTE_TOKEN_BUDGETS, READING_TOKEN_BUDGET, routeBudget } from "./profile-harness.ts"

describe("the budget keeps a reserve for the coordinator", () => {
  test("workers stop short of the cap and BEE goes on to it", () => {
    setTaskBudget("t", { maxInputTokens: 1_000, maxOutputTokens: 0, reserveShare: 0.2 })
    recordTaskUsage("t", 790, 0)
    expect(taskBudgetBlocker("t", "worker")).toBeUndefined()
    recordTaskUsage("t", 20, 0) // 810: past the workers' 800, under BEE's 1 000
    expect(taskBudgetBlocker("t", "worker")).toBe("task_input_tokens:800")
    expect(taskBudgetBlocker("t", "coordinator")).toBeUndefined()
    expect(taskBudgetBlocker("t")).toBeUndefined() // the default is the coordinator
    recordTaskUsage("t", 200, 0)
    expect(taskBudgetBlocker("t", "coordinator")).toBe("task_input_tokens:1000")
    clearTaskBudget("t")
  })

  test("without a reserve nothing changes for anyone", () => {
    setTaskBudget("u", { maxInputTokens: 100, maxOutputTokens: 0 })
    recordTaskUsage("u", 100, 0)
    expect(taskBudgetBlocker("u", "worker")).toBe("task_input_tokens:100")
    expect(taskBudgetBlocker("u", "coordinator")).toBe("task_input_tokens:100")
    clearTaskBudget("u")
  })

  test("every route carries the reserve, and scaling keeps it", () => {
    for (const tier of ["conversation", "scoped", "feature"] as const) expect(ROUTE_TOKEN_BUDGETS[tier].reserveShare).toBe(RESERVE_SHARE)
    expect(READING_TOKEN_BUDGET.reserveShare).toBe(RESERVE_SHARE)
    expect(routeBudget("scoped", { HIVECODE_BUDGET_SCALE: "2" }).reserveShare).toBe(RESERVE_SHARE)
  })
})

describe("«revisa el proyecto y planea mejoras» is a request for a plan", () => {
  test("the exact instruction that ran out of budget, typo included", () => {
    const signals = analyzeStatement("Hola revisa el proyecto y planea meejoras que encuentres")
    expect(signals).toMatchObject({ mutating: false, reading: true, planning: true })
    const decision = decideTier(signals)
    expect(decision.tier).toBe("conversation")
    expect(decision.signals).toContain("pide un plan como entrega")
  })

  test("other ways of asking for a plan, with and without accents or doubled letters", () => {
    for (const text of ["propón un roadmap para el módulo de auth", "prepara una hoja de ruta", "Planeeea las mejoras", "dame un plan de mejoras", "planifica qué arreglar primero"]) {
      expect({ text, planning: analyzeStatement(text).planning }).toEqual({ text, planning: true })
    }
  })

  test("a plain review is not a request for a plan", () => {
    expect(analyzeStatement("revisa el proyecto").planning).toBe(false)
    expect(analyzeStatement("corrige el typo en el README").planning).toBe(false)
  })
})
