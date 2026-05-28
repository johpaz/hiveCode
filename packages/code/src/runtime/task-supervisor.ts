export type TaskStage =
  | "understanding"
  | "planning"
  | "ready"
  | "executing"
  | "waiting_user"
  | "reviewing"
  | "integrating"
  | "completed"
  | "failed"
  | "cancelled"

export type ExecutionPolicy = "auto" | "approval"
export type TaskPriority = "interactive" | "background"

export interface TaskRuntimeRecord {
  taskId: string
  sessionId: string
  title: string
  stage: TaskStage
  executionPolicy: ExecutionPolicy
  priority: TaskPriority
  contextRevision: number
  parentTaskId?: string
  planId?: string
  workspaceId?: string
  worktreePath?: string
  branchName?: string
  mutating: boolean
  createdAt: number
  updatedAt: number
}

export interface TaskSupervisorLimits {
  maxConcurrentTasks: number
  maxConcurrentMutatingTasks: number
}

export interface CreateTaskInput {
  taskId?: string
  sessionId: string
  title: string
  stage?: TaskStage
  executionPolicy?: ExecutionPolicy
  priority?: TaskPriority
  parentTaskId?: string
  mutating?: boolean
  workspaceId?: string
  worktreePath?: string
  branchName?: string
}

export interface TaskStartDecision {
  ok: boolean
  reason?: "task_not_found" | "task_terminal" | "concurrency_limit" | "mutating_limit"
}

const ACTIVE_STAGES = new Set<TaskStage>([
  "understanding",
  "planning",
  "ready",
  "executing",
  "waiting_user",
  "reviewing",
  "integrating",
])

const TERMINAL_STAGES = new Set<TaskStage>(["completed", "failed", "cancelled"])

function defaultTaskId(): string {
  return typeof Bun !== "undefined" && typeof Bun.randomUUIDv7 === "function"
    ? Bun.randomUUIDv7()
    : crypto.randomUUID()
}

export class TaskSupervisor {
  private tasks = new Map<string, TaskRuntimeRecord>()
  private selectedTaskId: string | null = null

  constructor(
    private limits: TaskSupervisorLimits = {
      maxConcurrentTasks: 2,
      maxConcurrentMutatingTasks: 1,
    },
    private now: () => number = () => Date.now(),
  ) {}

  createTask(input: CreateTaskInput): TaskRuntimeRecord {
    const taskId = input.taskId ?? defaultTaskId()
    if (this.tasks.has(taskId)) {
      throw new Error(`Task already exists: ${taskId}`)
    }

    const timestamp = this.now()
    const task: TaskRuntimeRecord = {
      taskId,
      sessionId: input.sessionId,
      title: input.title,
      stage: input.stage ?? "understanding",
      executionPolicy: input.executionPolicy ?? "auto",
      priority: input.priority ?? "interactive",
      contextRevision: 0,
      parentTaskId: input.parentTaskId,
      workspaceId: input.workspaceId,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      mutating: input.mutating ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    this.tasks.set(taskId, task)
    this.selectedTaskId ??= taskId
    return { ...task }
  }

  getTask(taskId: string): TaskRuntimeRecord | undefined {
    const task = this.tasks.get(taskId)
    return task ? { ...task } : undefined
  }

  listTasks(): TaskRuntimeRecord[] {
    return [...this.tasks.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((task) => ({ ...task }))
  }

  listActiveTasks(): TaskRuntimeRecord[] {
    return this.listTasks().filter((task) => ACTIVE_STAGES.has(task.stage))
  }

  getSelectedTaskId(): string | null {
    return this.selectedTaskId
  }

  selectTask(taskId: string): boolean {
    if (!this.tasks.has(taskId)) return false
    this.selectedTaskId = taskId
    return true
  }

  updateStage(taskId: string, stage: TaskStage): TaskRuntimeRecord | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined

    task.stage = stage
    task.updatedAt = this.now()

    if (TERMINAL_STAGES.has(stage) && this.selectedTaskId === taskId) {
      this.selectedTaskId = this.listActiveTasks().at(-1)?.taskId ?? taskId
    }

    return { ...task }
  }

  updatePolicy(taskId: string, executionPolicy: ExecutionPolicy): TaskRuntimeRecord | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    task.executionPolicy = executionPolicy
    task.contextRevision += 1
    task.updatedAt = this.now()
    return { ...task }
  }

  assignWorkspace(
    taskId: string,
    workspace: Pick<TaskRuntimeRecord, "workspaceId" | "worktreePath" | "branchName">,
  ): TaskRuntimeRecord | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    task.workspaceId = workspace.workspaceId
    task.worktreePath = workspace.worktreePath
    task.branchName = workspace.branchName
    task.updatedAt = this.now()
    return { ...task }
  }

  canStart(taskId: string): TaskStartDecision {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, reason: "task_not_found" }
    if (TERMINAL_STAGES.has(task.stage)) return { ok: false, reason: "task_terminal" }

    const active = [...this.tasks.values()].filter(
      (candidate) => candidate.taskId !== taskId && ACTIVE_STAGES.has(candidate.stage),
    )
    if (active.length >= this.limits.maxConcurrentTasks) {
      return { ok: false, reason: "concurrency_limit" }
    }

    const activeMutating = active.filter((candidate) => candidate.mutating).length
    if (task.mutating && activeMutating >= this.limits.maxConcurrentMutatingTasks) {
      return { ok: false, reason: "mutating_limit" }
    }

    return { ok: true }
  }

  markMutating(taskId: string, mutating: boolean): TaskRuntimeRecord | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    task.mutating = mutating
    task.updatedAt = this.now()
    return { ...task }
  }
}
