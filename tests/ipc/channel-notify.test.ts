import { describe, it, expect, afterEach } from "bun:test"
import {
  sendToUserChannel,
  setChannelSendFn,
  setTuiSendFn,
} from "@johpaz/hivecode-core/gateway/channel-notify"
import { reportProgressTool, notifyTool } from "@johpaz/hivecode-core/tools/core"

// ─── Escribir por la TUI ES hablar con un canal ──────────────────────────────
//
// El bug que menembró esta vista: `report_progress` caía a su default
// (`"webchat"`), un canal que nunca fue implementado, fallaba, y el modelo
// respondía reintentando — un bucle infinito quemando tokens.
//
// Estos tests fijan las dos mitades del arreglo:
//   1. La TUI es un destino válido, no un plan B.
//   2. Ninguna tool de reporte lanza cuando no hay a quién reportar.

afterEach(() => {
  setChannelSendFn(null as never)
  setTuiSendFn(null as never)
})

describe("la TUI como destino", () => {
  it("entrega el mensaje a la TUI cuando el gateway no está arrancado", async () => {
    // Es el caso real de una sesión TUI: `startGateway` no se llamó, así que
    // no hay `_sendFn`.
    const received: string[] = []
    setTuiSendFn((m) => received.push(m))

    const result = await sendToUserChannel("tui", "user-1", "voy por el schema")
    expect(result.ok).toBe(true)
    expect(result.delivered_to).toBe("tui")
    expect(received).toEqual(["voy por el schema"])
  })

  it("cae a la TUI cuando el canal pedido no existe", async () => {
    const received: string[] = []
    setTuiSendFn((m) => received.push(m))
    // El gateway responde que el canal no existe.
    setChannelSendFn(async () => { throw new Error("Unknown channel: webchat") })

    const result = await sendToUserChannel("webchat", "u", "reporte")
    expect(result.ok).toBe(true)
    expect(result.delivered_to).toBe("tui")
    expect(received).toHaveLength(1)
  })

  it("usa el canal real cuando existe y está activo", async () => {
    const received: string[] = []
    setTuiSendFn((m) => received.push(m))
    setChannelSendFn(async (channel) => { received.push(`canal:${channel}`) })

    const result = await sendToUserChannel("telegram", "u", "hola")
    expect(result.delivered_to).toBe("telegram")
    // No se duplica: el canal real ganó.
    expect(received).toEqual(["canal:telegram"])
  })

  it("falla honestamente cuando no hay ningún destino", async () => {
    // Sin TUI y sin gateway no hay a quién reportar. Decirlo es correcto;
    // fingir que se entregó no.
    const result = await sendToUserChannel("tui", "u", "x")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not initialized")
  })

  it("propaga el fallo si ni la TUI puede recibir", async () => {
    setTuiSendFn(() => { throw new Error("socket cerrado") })
    const result = await sendToUserChannel("tui", "u", "x")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("socket cerrado")
  })
})

describe("las tools de reporte no lanzan", () => {
  it("report_progress degrada en vez de reventar", async () => {
    // El throw original convertía cada reporte en un error de tool, y el
    // modelo respondía reintentando.
    setTuiSendFn(null as never)

    const result = await reportProgressTool.execute(
      { progress: 40, message: "analizando el schema" },
      { configurable: { channel: "webchat", user_id: "u" } },
    ) as Record<string, unknown>

    expect(result.ok).toBe(false)
    expect(result.reported).toBe(false)
    expect(result.progress).toBe(40)
    // El aviso tiene que ser explícito: el modelo necesita entender que
    // reintentar no va a ayudar.
    expect(String(result.aviso)).toContain("NO vuelvas a llamar")
  })

  it("notify degrada con el mismo criterio", async () => {
    setTuiSendFn(null as never)

    const result = await notifyTool.execute(
      { message: "aviso" },
      { configurable: { channel: "webchat", user_id: "u" } },
    ) as Record<string, unknown>

    expect(result.ok).toBe(false)
    expect(String(result.aviso)).toContain("NO reintentes")
  })

  it("report_progress confirma cuando sí se entregó", async () => {
    const received: string[] = []
    setTuiSendFn((m) => received.push(m))

    const result = await reportProgressTool.execute(
      { progress: 100, message: "listo" },
      { configurable: { channel: "tui", user_id: "u" } },
    ) as Record<string, unknown>

    expect(result.ok).toBe(true)
    expect(result.reported).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]).toContain("100%")
  })

  it("el aviso nombra el canal que falta, para que el error sea diagnosticable", async () => {
    setTuiSendFn(null as never)
    const result = await reportProgressTool.execute(
      { progress: 10, message: "x" },
      { configurable: { channel: "discord", user_id: "u" } },
    ) as Record<string, unknown>
    expect(String(result.aviso)).toContain("discord")
  })
})