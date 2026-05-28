import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CoordinatorManager } from "../../src/workers/coordinator-manager"
import { initSessionArray, setMode } from "../../src/modes/session-array"
import type { Tool } from "@johpaz/hivecode-core/tools"
import { cleanupTestDb, resetTestDb } from "../helpers/setup-db"

beforeAll(() => {
  resetTestDb()
})

afterAll(() => {
  cleanupTestDb()
})

describe("CoordinatorManager file leases", () => {
  test("blocks a second worker from mutating a leased file", async () => {
    initSessionArray()
    setMode("auto")

    let releaseFirst!: (value: object) => void
    const fsEditTool: Tool = {
      name: "fs_edit",
      description: "edit file",
      parameters: { type: "object", properties: {} },
      execute: () => new Promise((resolve) => { releaseFirst = resolve }),
    }

    const backendMessages: string[] = []
    const frontendMessages: string[] = []
    const ipcEvents: Array<{ event: string; payload: any }> = []

    const manager = new CoordinatorManager() as any
    const sessionId = manager.scribe.createSession(process.cwd())
    const taskId = manager.scribe.createTask(sessionId, "lease test", "auto")
    manager.activeTaskId = taskId
    manager.activeSessionId = sessionId
    manager.allTools = [fsEditTool]
    manager.workers.set("backend", { postMessage: (msg: string) => backendMessages.push(msg) })
    manager.workers.set("frontend", { postMessage: (msg: string) => frontendMessages.push(msg) })
    manager.setIpcCallback((event: string, payload: any) => ipcEvents.push({ event, payload }))

    const first = manager.handleToolCall("backend", {
      type: "TOOL_CALL",
      taskId,
      phaseId: 1,
      coordinator: "backend",
      toolName: "fs_edit",
      toolArgs: { path: "src/app.ts" },
      toolCallId: "call-1",
    })

    await Promise.resolve()

    await manager.handleToolCall("frontend", {
      type: "TOOL_CALL",
      taskId,
      phaseId: 2,
      coordinator: "frontend",
      toolName: "fs_edit",
      toolArgs: { path: "./src/app.ts" },
      toolCallId: "call-2",
    })

    expect(frontendMessages.join("\n")).toContain("[LEASE]")
    expect(ipcEvents.some(({ event }) => event === "conflict_alert")).toBe(true)

    releaseFirst({ ok: true, edited: true })
    await first
    expect(backendMessages.join("\n")).toContain("call-1")
  })
})
