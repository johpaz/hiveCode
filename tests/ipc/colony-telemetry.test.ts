import { describe, expect, test } from "bun:test"
import { trackCollaboration } from "../../packages/core/src/agent/collaboration-telemetry"
import { createOutputTelemetry } from "../../packages/core/src/agent/tool-telemetry"
import { eventBus, type EventMap } from "../../packages/core/src/events/event-bus"
import { messagePriority } from "../../packages/core/src/ipc/protocol"

describe("colony execution telemetry", () => {
  test("a delegation has one terminal handoff, exact instance identity and bounded content", () => {
    const events: EventMap["swarm:collaboration"][] = []
    const off = eventBus.on("swarm:collaboration", event => { events.push(event) })
    try {
      const finish = trackCollaboration({ from: "bee", to: "builder#2", taskId: "task", sessionId: "session", summary: "Build\n auth" })
      finish(true, "x".repeat(500)); finish(false, "duplicate")
      expect(events).toHaveLength(2)
      expect(events[0].summary).toBe("Build auth")
      expect(events[1].kind).toBe("handoff")
      expect(events[1].summary).toHaveLength(240)
      expect(events[1].delegation_id).toBe(events[0].delegation_id)
      expect(events[1].event_id).not.toBe(events[0].event_id)
      expect(events[1].to).toBe("builder#2")
      expect(events[1].task_id).toBe("task")
      expect(messagePriority({ type: "swarm_collaboration", ...events[1] })).toBe("normal")
    } finally { off() }
  })

  test("failed execution produces failure rather than a successful handoff", () => {
    const events: EventMap["swarm:collaboration"][] = []
    const off = eventBus.on("swarm:collaboration", event => { events.push(event) })
    try {
      trackCollaboration({ from: "bee", to: "child", summary: "Review" })(false, "cancelled")
      expect(events.map(e => e.kind)).toEqual(["delegation", "failed"])
      expect(events[1].summary).toBe("cancelled")
    } finally { off() }
  })

  test("worker token batches preserve both channels and do not duplicate aggregate responses", () => {
    const events: EventMap["agent:output"][] = []
    const off = eventBus.on("agent:output", event => { events.push(event) })
    try {
      const output = createOutputTelemetry({ agentId: "builder#2", taskId: "task", sessionId: "session" })
      output.reasoning("reason "); output.reasoning("more")
      output.narrative("work "); output.narrative("done")
      output.finish({ reasoning_content: "reason more", content: "work done" })
      expect(events.filter(e => e.kind === "reasoning").map(e => e.content).join("")).toBe("reason more")
      expect(events.filter(e => e.kind === "narrative").map(e => e.content).join("")).toBe("work done")
      expect(events.every(e => e.agentId === "builder#2" && e.taskId === "task")).toBe(true)
    } finally { off() }
  })

  test("providers without token callbacks still expose their available output", () => {
    const events: EventMap["agent:output"][] = []
    const off = eventBus.on("agent:output", event => { events.push(event) })
    try {
      createOutputTelemetry({ agentId: "scout" }).finish({ reasoning_content: "reason", content: "found" })
      expect(events.map(e => [e.kind,e.content])).toEqual([["reasoning","reason"],["narrative","found"]])
    } finally { off() }
  })
})
