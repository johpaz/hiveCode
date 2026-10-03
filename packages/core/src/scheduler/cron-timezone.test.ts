/**
 * Regresión de Bun 1.4: `Bun.cron` pasó de interpretar las expresiones en UTC a
 * interpretarlas en la hora local del proceso. El scheduler compensaba el
 * comportamiento viejo corriendo el campo de hora con el offset de la zona, así
 * que el cambio convirtió esa compensación en una doble conversión y los jobs
 * disparaban con el offset local de retraso.
 *
 * Estos tests fijan la semántica correcta —"las 9" es las 9 del reloj de pared
 * de la zona del job, sin importar la del proceso— para que no vuelva a
 * depender de en qué zona corre el servidor.
 */
import { describe, test, expect } from "bun:test"
import { parseCronExpression, nextOccurrence } from "./cron"

function proximaCorrida(expr: string, timeZone: string, desde: Date): Date {
  const next = nextOccurrence(parseCronExpression(expr), desde, { timeZone })
  expect(next).not.toBeNull()
  return next!
}

/** La hora de pared que marca un reloj colgado en esa zona, en ese instante. */
function horaDePared(instante: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(instante)
}

describe("cron con zona horaria", () => {
  const desde = new Date("2026-09-05T17:15:00.000Z") // 12:15 en Bogotá

  test("'0 9 * * *' en America/Bogota cae 09:00 de pared = 14:00Z", () => {
    const next = proximaCorrida("0 9 * * *", "America/Bogota", desde)
    expect(next.toISOString()).toBe("2026-09-06T14:00:00.000Z")
    expect(horaDePared(next, "America/Bogota")).toBe("09:00")
  })

  test("la zona del job manda, no la del proceso", () => {
    // Mismo instante de partida, tres zonas: cada una da un instante UTC distinto
    // y todas marcan las 09:00 en su propio reloj.
    for (const tz of ["America/Bogota", "UTC", "Europe/Madrid", "Asia/Tokyo"]) {
      const next = proximaCorrida("0 9 * * *", tz, desde)
      expect(horaDePared(next, tz)).toBe("09:00")
    }
  })

  test("acierta cruzando el cambio de horario de verano", () => {
    // Madrid pasa de CET (+1) a CEST (+2) el 29 de marzo de 2026 a las 02:00.
    // Sumar el offset una sola vez falla justo acá: da 08:00 de pared, no 09:00.
    const antes = proximaCorrida("0 9 * * *", "Europe/Madrid", new Date("2026-03-28T12:00:00.000Z"))
    expect(antes.toISOString()).toBe("2026-03-29T07:00:00.000Z") // +2, ya en CEST
    expect(horaDePared(antes, "Europe/Madrid")).toBe("09:00")

    const invierno = proximaCorrida("0 9 * * *", "Europe/Madrid", new Date("2026-03-27T12:00:00.000Z"))
    expect(invierno.toISOString()).toBe("2026-03-28T08:00:00.000Z") // +1, todavía CET
    expect(horaDePared(invierno, "Europe/Madrid")).toBe("09:00")
  })

  test("acepta los 6 campos que Bun.cron rechaza", () => {
    expect(() => parseCronExpression("30 0 9 * * *")).not.toThrow()
    expect(() => Bun.cron("30 0 9 * * *" as never, () => {})).toThrow()
  })
})
