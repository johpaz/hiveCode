import { describe, expect, test } from "bun:test"
import { classifyTask, DEFAULT_MAX_AGENT_CONCURRENCY, DEFAULT_MAX_REPAIR_CYCLES } from "./adaptive-scheduler.ts"

describe("adaptive harness policy", () => {
  test("keeps conversation and small fixes off the SDD path", () => {
    expect(classifyTask("¿Qué hace este módulo?")).toBe("conversation")
    expect(classifyTask("Corrige el typo en README.md")).toBe("simple_change")
  })

  test("reads destructive and editing verbs as changes, not conversation", () => {
    for (const task of [
      "borra el archivo old.txt", "Elimina los logs viejos", "renombra utils.ts a helpers.ts",
      "quita la dependencia lodash", "actualiza la versión en package.json", "edita el README",
      "delete the tmp folder", "rename the module", "escribe un test para el parser",
    ]) expect(classifyTask(task), task).toBe("simple_change")
  })

  test("a noun is not an order", () => {
    for (const question of [
      "¿Qué cambio hizo el último commit?", "explica la modificación del parser",
      "¿Por qué falló la actualización?", "háblame de la eliminación en cascada",
    ]) expect(classifyTask(question), question).toBe("conversation")
  })

  test("routes architectural work through Spec Kit", () => {
    expect(classifyTask("Rediseña la arquitectura del agent loop")).toBe("complex")
    expect(classifyTask("Implement a database schema migration")).toBe("complex")
    expect(classifyTask(
      "creas una landing page de este proyecto en astro, consulta la documentación oficial",
    )).toBe("complex")
  })

  test("uses bounded defaults", () => {
    expect(DEFAULT_MAX_AGENT_CONCURRENCY).toBe(4)
    expect(DEFAULT_MAX_REPAIR_CYCLES).toBe(2)
  })
})
