import { afterEach, describe, expect, test } from "bun:test"
import {
  canRequestToolApproval,
  registerToolApprovalRequester,
  requestToolApproval,
  resolveToolApproval,
  toolApprovalDetail,
  type ToolApprovalRequest,
} from "./tool-approval"

const call = { agent: "builder", tool: "fs_write", summary: "{\"path\":\"a.txt\"}", detail: "{}" }

afterEach(() => registerToolApprovalRequester(null))

describe("tool approval", () => {
  test("sin requester no se puede pedir y se deniega", async () => {
    expect(canRequestToolApproval()).toBe(false)
    expect(await requestToolApproval(call)).toBe(false)
  })

  test("la respuesta de la TUI resuelve la solicitud con su request_id", async () => {
    const seen: ToolApprovalRequest[] = []
    registerToolApprovalRequester(r => seen.push(r))
    expect(canRequestToolApproval()).toBe(true)

    const answer = requestToolApproval(call)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject(call)
    expect(resolveToolApproval(seen[0].request_id, true)).toBe(true)
    expect(await answer).toBe(true)
    // Una respuesta repetida ya no encuentra la solicitud.
    expect(resolveToolApproval(seen[0].request_id, false)).toBe(false)
  })

  test("rechazar devuelve false", async () => {
    const seen: ToolApprovalRequest[] = []
    registerToolApprovalRequester(r => seen.push(r))
    const answer = requestToolApproval(call)
    resolveToolApproval(seen[0].request_id, false)
    expect(await answer).toBe(false)
  })

  test("cada solicitud tiene su propio id y se responden por separado", async () => {
    const seen: ToolApprovalRequest[] = []
    registerToolApprovalRequester(r => seen.push(r))
    const first = requestToolApproval(call)
    const second = requestToolApproval({ ...call, tool: "fs_delete" })
    expect(seen[0].request_id).not.toBe(seen[1].request_id)
    resolveToolApproval(seen[1].request_id, true)
    resolveToolApproval(seen[0].request_id, false)
    expect(await first).toBe(false)
    expect(await second).toBe(true)
  })

  test("abortar la tarea deniega la solicitud pendiente", async () => {
    registerToolApprovalRequester(() => {})
    const controller = new AbortController()
    const answer = requestToolApproval(call, controller.signal)
    controller.abort()
    expect(await answer).toBe(false)
  })

  test("desregistrar el requester (la TUI se fue) deniega lo pendiente", async () => {
    registerToolApprovalRequester(() => {})
    const answer = requestToolApproval(call)
    registerToolApprovalRequester(null)
    expect(await answer).toBe(false)
  })

  test("el detalle largo se recorta", () => {
    expect(toolApprovalDetail({ content: "x".repeat(5_000) }).length).toBeLessThan(1_300)
  })
})

describe("tool approval: rechazos repetidos", () => {
  test("la misma llamada rechazada no se vuelve a preguntar en la misma tarea", async () => {
    const seen: ToolApprovalRequest[] = []
    registerToolApprovalRequester(r => seen.push(r))
    const first = requestToolApproval(call, undefined, "task-A")
    resolveToolApproval(seen[0].request_id, false)
    expect(await first).toBe(false)

    expect(await requestToolApproval(call, undefined, "task-A")).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test("otra tarea, u otros argumentos, sí se preguntan", async () => {
    const seen: ToolApprovalRequest[] = []
    registerToolApprovalRequester(r => seen.push(r))
    const first = requestToolApproval(call, undefined, "task-B")
    resolveToolApproval(seen[0].request_id, false)
    await first

    void requestToolApproval(call, undefined, "task-C")
    void requestToolApproval({ ...call, detail: "{\"path\":\"otro.txt\"}" }, undefined, "task-B")
    expect(seen).toHaveLength(3)
  })

  test("una llamada autorizada no queda marcada como rechazada", async () => {
    const seen: ToolApprovalRequest[] = []
    registerToolApprovalRequester(r => seen.push(r))
    const first = requestToolApproval(call, undefined, "task-D")
    resolveToolApproval(seen[0].request_id, true)
    expect(await first).toBe(true)
    void requestToolApproval(call, undefined, "task-D")
    expect(seen).toHaveLength(2)
  })
})
