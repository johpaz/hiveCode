import { describe, expect, test } from "bun:test"
import { TaskSupervisor } from "../../src/runtime/task-supervisor"

describe("TaskSupervisor", () => {
  test("creates independent task runtimes and selects the first task", () => {
    let now = 100
    const supervisor = new TaskSupervisor(undefined, () => now++)

    const a = supervisor.createTask({ taskId: "task-a", sessionId: "s1", title: "Plan API", executionPolicy: "approval" })
    const b = supervisor.createTask({ taskId: "task-b", sessionId: "s1", title: "Fix copy", executionPolicy: "auto" })

    expect(a.stage).toBe("understanding")
    expect(a.executionPolicy).toBe("approval")
    expect(b.executionPolicy).toBe("auto")
    expect(supervisor.getSelectedTaskId()).toBe("task-a")
    expect(supervisor.listTasks().map((task) => task.taskId)).toEqual(["task-a", "task-b"])
  })

  test("policy changes are per task and bump context revision", () => {
    const supervisor = new TaskSupervisor()
    supervisor.createTask({ taskId: "task-a", sessionId: "s1", title: "A", executionPolicy: "auto" })
    supervisor.createTask({ taskId: "task-b", sessionId: "s1", title: "B", executionPolicy: "approval" })

    supervisor.updatePolicy("task-a", "approval")

    expect(supervisor.getTask("task-a")?.executionPolicy).toBe("approval")
    expect(supervisor.getTask("task-a")?.contextRevision).toBe(1)
    expect(supervisor.getTask("task-b")?.executionPolicy).toBe("approval")
    expect(supervisor.getTask("task-b")?.contextRevision).toBe(0)
  })

  test("enforces total and mutating concurrency limits", () => {
    const supervisor = new TaskSupervisor({ maxConcurrentTasks: 2, maxConcurrentMutatingTasks: 1 })
    supervisor.createTask({ taskId: "task-a", sessionId: "s1", title: "A", mutating: true, stage: "executing" })
    supervisor.createTask({ taskId: "task-b", sessionId: "s1", title: "B", mutating: false, stage: "planning" })
    supervisor.createTask({ taskId: "task-c", sessionId: "s1", title: "C", mutating: false, stage: "ready" })
    supervisor.createTask({ taskId: "task-d", sessionId: "s1", title: "D", mutating: true, stage: "completed" })

    expect(supervisor.canStart("task-c")).toEqual({ ok: false, reason: "concurrency_limit" })
    supervisor.updateStage("task-b", "completed")
    expect(supervisor.canStart("task-c")).toEqual({ ok: true })
    supervisor.updateStage("task-c", "completed")
    supervisor.updateStage("task-d", "ready")
    expect(supervisor.canStart("task-d")).toEqual({ ok: false, reason: "mutating_limit" })
  })
})
