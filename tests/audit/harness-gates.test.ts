import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHiveDb } from "../../packages/core/src/storage/hivedb";
import { CoordinatorManager } from "../../packages/code/src/workers/coordinator-manager";
import { ProfileHarness } from "../../packages/core/src/harness/profile-harness";
import { registerToolApprovalRequester, resolveToolApproval, type ToolApprovalRequest } from "../../packages/core/src/agent/tool-approval";

// Las puertas `specification` y `convergence` del harness antes sólo existían en la
// consola: dentro de la TUI no había quien contestara y la tarea quedaba en
// `waiting_user`. Ahora se preguntan por el mismo canal IPC que las herramientas.
const realRun = ProfileHarness.prototype.run
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" })

/** What the real harness leaves behind: a task row, which is all the approval looks for. */
async function writeHarnessRow(taskId: string, patch: Record<string, unknown>) {
  const { col } = await import("../../packages/core/src/storage/hive")
  const rows = await col<any>("harnessTasks")
  const existing = await rows.get(taskId)
  const doc = { taskId, sessionId: "s", title: "", stage: "understanding", executionPolicy: "approval", priority: "interactive", contextRevision: 1, mutating: true, createdAt: Date.now(), updatedAt: Date.now(), ...(existing?.doc ?? {}), ...patch }
  await rows.put(taskId, doc, { expectedVersion: existing?.version ?? 0 })
}

/**
 * These tests run real tasks, and a task that mutates files gets a worktree in the shared
 * `<tmp>/hivecode-worktrees`. Only the ones that belong to this file's throwaway repos are removed:
 * anyone else's worktrees there are not ours to touch.
 */
function removeOwnWorktrees() {
  const root = join(tmpdir(), "hivecode-worktrees")
  let names: string[] = []
  try { names = readdirSync(root) } catch { return }
  for (const name of names) {
    try {
      const pointer = readFileSync(join(root, name, ".git"), "utf-8")
      if (/hive-(gates|integ|reuse|stale|cancel)-repo-/.test(pointer)) rmSync(join(root, name), { recursive: true, force: true })
    } catch { /* not a worktree of ours */ }
  }
}

afterEach(() => {
  removeOwnWorktrees()
  ProfileHarness.prototype.run = realRun
  registerToolApprovalRequester(null)
})

async function runApproval(setup: (asked: ToolApprovalRequest[]) => void) {
  const previousDb = process.env.HIVE_DB_PATH
  const previousCwd = process.cwd()
  closeHiveDb()
  process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-gates-"))
  const repo = mkdtempSync(join(tmpdir(), "hive-gates-repo-"))
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "init")
  process.chdir(repo)

  let approve: ((gate: "specification" | "convergence", evidence: string) => Promise<"approve" | "cancel">) | undefined
  ProfileHarness.prototype.run = (async (options: any) => {
    approve = options.approve
    return { taskId: "t", complexity: "complex", status: "completed", response: "ok", repairCycles: 0 }
  }) as unknown as typeof realRun

  const asked: ToolApprovalRequest[] = []
  setup(asked)
  try {
    await new CoordinatorManager().runTask("crea un proyecto con tests", "approval")
    return { approve, asked }
  } finally {
    process.chdir(previousCwd)
    closeHiveDb()
    if (previousDb === undefined) delete process.env.HIVE_DB_PATH
    else process.env.HIVE_DB_PATH = previousDb
  }
}

test("in approval mode the TUI answers the harness gates", async () => {
  const { approve, asked } = await runApproval(list => registerToolApprovalRequester(r => list.push(r)))
  expect(approve).toBeDefined()

  const decision = approve!("specification", "# Plan\n1. hacer algo")
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ agent: "bee", kind: "gate" })
  expect(asked[0].title).toContain("ESPECIFICACIÓN")
  expect(asked[0].detail).toContain("hacer algo")
  resolveToolApproval(asked[0].request_id, true)
  expect(await decision).toBe("approve")

  const closing = approve!("convergence", "resultado")
  expect(asked[1].title).toContain("RESULTADO")
  resolveToolApproval(asked[1].request_id, false)
  expect(await closing).toBe("cancel")
})

test("without a TUI the harness is given no approver, as before", async () => {
  const { approve } = await runApproval(() => {})
  expect(approve).toBeUndefined()
})

test("a task whose work cannot be integrated is not reported as done", async () => {
  const previousDb = process.env.HIVE_DB_PATH
  const previousCwd = process.cwd()
  closeHiveDb()
  process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-integ-"))
  const repo = mkdtempSync(join(tmpdir(), "hive-integ-repo-"))
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "init")
  process.chdir(repo)
  ProfileHarness.prototype.run = (async () => (
    { taskId: "t", complexity: "complex", status: "completed", response: "todo listo", repairCycles: 0 }
  )) as unknown as typeof realRun
  try {
    const manager = new CoordinatorManager()
    const updates: string[] = []
    manager.setIpcCallback((event, payload: any) => { if (event === "task_update") updates.push(payload.status) })
    let finalText = ""
    manager.setTaskCompleteCallback(text => { finalText = text })
    const workspaceManager = (manager as any).workspaceManager
    workspaceManager.integrate = async () => ({ status: "conflict", error: "patch does not apply" })

    await manager.runTask("crea un proyecto con tests", "auto")

    expect(finalText).toContain("todo listo")
    expect(finalText).toContain("NO se pudo aplicar")
    expect(finalText).toContain("hivecode/task-")
    expect(updates).not.toContain("completed")
    expect(updates).toContain("paused")
    // El trabajo retenido es de este test: no se deja en /tmp.
    for (const assignment of (manager as any).taskWorkspaces.values()) {
      if (assignment.isolated) await workspaceManager.cleanup(assignment)
    }
  } finally {
    process.chdir(previousCwd)
    closeHiveDb()
    if (previousDb === undefined) delete process.env.HIVE_DB_PATH
    else process.env.HIVE_DB_PATH = previousDb
  }
})

test("approving the plan that plan mode made resumes it instead of planning again", async () => {
  const previousDb = process.env.HIVE_DB_PATH
  const previousCwd = process.cwd()
  closeHiveDb()
  process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-reuse-"))
  const repo = mkdtempSync(join(tmpdir(), "hive-reuse-repo-"))
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "init")
  process.chdir(repo)

  const seen: Array<{ policy: string; resumeTaskId?: string }> = []
  ProfileHarness.prototype.run = (async (options: any) => {
    seen.push({ policy: options.policy, resumeTaskId: options.resumeTaskId })
    if (options.policy === "plan") {
      await writeHarnessRow("harness:plan-1", { title: options.objective, stage: "ready", planId: "specs/001-x" })
      return { taskId: "harness:plan-1", complexity: "complex", status: "ready", response: "PLAN", featureDir: "specs/001-x", repairCycles: 0 }
    }
    // Reanudar un plan lo hace avanzar: ya no está "ready", así que se usa una sola vez.
    if (options.resumeTaskId) await writeHarnessRow(options.resumeTaskId, { stage: "completed" })
    return { taskId: options.resumeTaskId ?? "harness:new", complexity: "complex", status: "completed", response: "hecho", repairCycles: 0 }
  }) as unknown as typeof realRun
  try {
    const task = "crea un proyecto con tests"
    await new CoordinatorManager().runTask(task, "plan")
    // Otra instancia, como tras cerrar y reabrir la TUI: el plan está en HiveDB, no en memoria.
    const reopened = new CoordinatorManager()
    await reopened.runTask(task, "auto")
    // Una tarea distinta, o la misma otra vez, no arrastra el plan viejo.
    await reopened.runTask(task, "auto")
    await reopened.runTask("otra cosa distinta que crear en un proyecto", "auto")

    expect(seen[0]).toEqual({ policy: "plan", resumeTaskId: undefined })
    expect(seen[1]).toEqual({ policy: "auto", resumeTaskId: "harness:plan-1" })
    expect(seen[2].resumeTaskId).toBeUndefined()
    expect(seen[3].resumeTaskId).toBeUndefined()
  } finally {
    process.chdir(previousCwd)
    closeHiveDb()
    if (previousDb === undefined) delete process.env.HIVE_DB_PATH
    else process.env.HIVE_DB_PATH = previousDb
  }
})

test("cancelling at a gate leaves no worktree or branch behind", async () => {
  const previousDb = process.env.HIVE_DB_PATH
  const previousCwd = process.cwd()
  closeHiveDb()
  process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-cancel-"))
  const repo = mkdtempSync(join(tmpdir(), "hive-cancel-repo-"))
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "init")
  process.chdir(repo)
  ProfileHarness.prototype.run = (async () => (
    { taskId: "t", complexity: "complex", status: "cancelled", response: "plan", featureDir: "specs/001-x", repairCycles: 0 }
  )) as unknown as typeof realRun
  try {
    await new CoordinatorManager().runTask("crea un proyecto con tests", "approval")

    expect(git(repo, "worktree", "list").toString().trim().split("\n")).toHaveLength(1)
    expect(git(repo, "branch", "--list", "hivecode/*").toString().trim()).toBe("")
  } finally {
    process.chdir(previousCwd)
    closeHiveDb()
    if (previousDb === undefined) delete process.env.HIVE_DB_PATH
    else process.env.HIVE_DB_PATH = previousDb
  }
})

test("a plan older than the reuse window is not resumed", async () => {
  const previousDb = process.env.HIVE_DB_PATH
  const previousCwd = process.cwd()
  closeHiveDb()
  process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-stale-"))
  const repo = mkdtempSync(join(tmpdir(), "hive-stale-repo-"))
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "init")
  process.chdir(repo)

  const seen: Array<string | undefined> = []
  ProfileHarness.prototype.run = (async (options: any) => {
    seen.push(options.resumeTaskId)
    if (options.policy === "plan") {
      await writeHarnessRow("harness:plan-old", { title: options.objective, stage: "ready", planId: "specs/001-x" })
      return { taskId: "harness:plan-old", complexity: "complex", status: "ready", response: "PLAN", featureDir: "specs/001-x", repairCycles: 0 }
    }
    return { taskId: "harness:x", complexity: "complex", status: "completed", response: "hecho", repairCycles: 0 }
  }) as unknown as typeof realRun
  try {
    const manager = new CoordinatorManager()
    const task = "crea un proyecto con tests"
    await manager.runTask(task, "plan")

    // Envejece la tarea del plan más allá de la ventana de reutilización.
    await writeHarnessRow("harness:plan-old", { updatedAt: Date.now() - 31 * 60_000 })

    await manager.runTask(task, "auto")
    expect(seen).toEqual([undefined, undefined])
  } finally {
    process.chdir(previousCwd)
    closeHiveDb()
    if (previousDb === undefined) delete process.env.HIVE_DB_PATH
    else process.env.HIVE_DB_PATH = previousDb
  }
})

test("a blocked worker shows up in the chat as a visible warning", async () => {
  const previousDb = process.env.HIVE_DB_PATH
  const previousCwd = process.cwd()
  closeHiveDb()
  process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-warn-"))
  process.chdir(mkdtempSync(join(tmpdir(), "hive-warn-cwd-")))
  ProfileHarness.prototype.run = (async (options: any) => {
    options.onEvent({ type: "agent_blocked", agent: "builder", message: "repitió la misma llamada (shell_executor) sin avanzar" })
    return { taskId: "t", complexity: "complex", status: "ready", response: "x", repairCycles: 0 }
  }) as unknown as typeof realRun
  try {
    const manager = new CoordinatorManager()
    const events: Array<{ event: string; payload: any }> = []
    manager.setIpcCallback((event, payload) => events.push({ event, payload }))

    await manager.runTask("diseña un arnés para una CLI llamada bee-notes con tests", "plan")

    const warning = events.find(e => e.event === "history_append" && String(e.payload.content).includes("se bloqueó"))
    expect(warning?.payload.role).toBe("system")
    expect(warning?.payload.content).toContain("builder se bloqueó: repitió la misma llamada")
    expect(events.some(e => e.event === "worker_update" && e.payload.worker === "builder" && e.payload.status === "blocked")).toBe(true)
  } finally {
    process.chdir(previousCwd)
    closeHiveDb()
    if (previousDb === undefined) delete process.env.HIVE_DB_PATH
    else process.env.HIVE_DB_PATH = previousDb
  }
})
