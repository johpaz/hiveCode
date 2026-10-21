import { describe, expect, test } from "bun:test"
import { extractPlanPhases } from "../packages/code/src/workers/coordinator-manager"

describe("extractPlanPhases", () => {
  test("convierte una lista numerada en fases encadenadas", () => {
    const phases = extractPlanPhases("Plan:\n1. Crear modelo\n2. **Agregar rutas**\n3. Escribir tests")
    expect(phases.map((p) => p.name)).toEqual(["Crear modelo", "Agregar rutas", "Escribir tests"])
    expect(phases[0].depends_on).toEqual([])
    expect(phases[2].depends_on).toEqual(["Agregar rutas"])
    expect(phases[2].level).toBe(2)
  })

  test("sin lista reconocible devuelve una fase genérica", () => {
    const phases = extractPlanPhases("Haré los cambios necesarios.")
    expect(phases).toHaveLength(1)
    expect(phases[0].name).toBe("Ejecutar plan")
  })
})
