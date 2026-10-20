import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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

afterEach(() => {
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
    return options.policy === "plan"
      ? { taskId: "harness:plan-1", complexity: "complex", status: "ready", response: "PLAN", featureDir: "specs/001-x", repairCycles: 0 }
      : { taskId: options.resumeTaskId ?? "harness:new", complexity: "complex", status: "completed", response: "hecho", repairCycles: 0 }
  }) as unknown as typeof realRun
  try {
    const manager = new CoordinatorManager()
    const task = "crea un proyecto con tests"
    await manager.runTask(task, "plan")
    await manager.runTask(task, "auto")
    // Una tarea distinta, o la misma otra vez, no arrastra el plan viejo.
    await manager.runTask(task, "auto")
    await manager.runTask("otra cosa distinta que crear en un proyecto", "auto")

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
