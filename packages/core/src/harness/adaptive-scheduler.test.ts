import { describe, expect, test } from "bun:test"
import { classifyTask, DEFAULT_MAX_AGENT_CONCURRENCY, DEFAULT_MAX_REPAIR_CYCLES } from "./adaptive-scheduler.ts"

describe("adaptive harness policy", () => {
  test("keeps conversation and small fixes off the SDD path", () => {
    expect(classifyTask("¿Qué hace este módulo?")).toBe("conversation")
    expect(classifyTask("Corrige el typo en README.md")).toBe("simple_change")
  })

  test("routes architectural work through Spec Kit", () => {
    expect(classifyTask("Rediseña la arquitectura del agent loop")).toBe("complex")
    expect(classifyTask("Implement a database schema migration")).toBe("complex")
    expect(classifyTask(
      "creas una landing page de este proyecto en astro, consulta la documentación oficial",
    )).toBe("complex")
  })

  test("uses bounded defaults", () => {
    expect(DEFAULT_MAX_AGENT_CONCURRENCY).toBe(3)
    expect(DEFAULT_MAX_REPAIR_CYCLES).toBe(2)
  })
})
