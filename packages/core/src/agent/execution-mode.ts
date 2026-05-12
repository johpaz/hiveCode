import { getHiveDir } from "../config/loader"
import { logger } from "../utils/logger"
import * as fs from "fs"
import * as path from "path"

const log = logger.child("execution-mode")

export type ExecutionMode = "plan" | "approval" | "auto"

const MODE_FILE = "execution_mode"

function getModeFilePath(): string {
  return path.join(getHiveDir(), MODE_FILE)
}

export function getExecutionMode(): ExecutionMode {
  try {
    const filePath = getModeFilePath()
    if (!fs.existsSync(filePath)) return "plan"
    const mode = fs.readFileSync(filePath, "utf-8").trim().toLowerCase()
    if (mode === "approval") return "approval"
    if (mode === "auto") return "auto"
    if (mode === "exec") return "auto"
    return "plan"
  } catch {
    return "plan"
  }
}

export function setExecutionMode(mode: ExecutionMode): void {
  const filePath = getModeFilePath()
  fs.writeFileSync(filePath, mode, "utf-8")
  log.info(`[execution-mode] Mode set to: ${mode}`)
}

export function modeCycle(current: ExecutionMode): ExecutionMode {
  const order: ExecutionMode[] = ["plan", "approval", "auto"]
  const idx = order.indexOf(current)
  return order[(idx + 1) % 3]
}

const PLAN_BLOCKED_TOOLS = new Set([
  "fs_write", "fs_edit", "fs_delete", "shell_executor",
  "codebridge_launch", "codebridge_cancel",
  "code_lint", "code_test", "code_build", "code_commit",
  "git_commit", "git_push",
  "cron.create", "cron.update", "cron.pause", "cron.resume",
  "cron.delete", "cron.trigger",
  "agent_create", "agent_archive", "task_delegate", "task_delegate_code",
  "memory_delete",
  "project_create", "project_update", "project_done", "project_fail",
  "task_create", "task_update", "task_evaluate",
])

const CONFIRM_REQUIRED_TOOLS = new Set([
  "cli_exec", "fs_write", "fs_edit", "fs_delete",
  "codebridge_launch", "git_commit", "code_commit",
  "cron.delete", "agent_archive",
])

export function canExecuteTool(toolName: string, mode?: ExecutionMode): boolean {
  const currentMode = mode ?? getExecutionMode()
  if (currentMode === "plan" && PLAN_BLOCKED_TOOLS.has(toolName)) return false
  return true
}

export function requiresConfirmation(toolName: string): boolean {
  return CONFIRM_REQUIRED_TOOLS.has(toolName)
}

export function filterToolsByMode<T extends { name: string }>(
  tools: T[], mode?: ExecutionMode
): T[] {
  const currentMode = mode ?? getExecutionMode()
  if (currentMode !== "plan") return tools
  return tools.filter(t => !PLAN_BLOCKED_TOOLS.has(t.name))
}

export function getBlockReason(toolName: string): string {
  return `[PERMISSION DENIED] '${toolName}' requiere modo approval o auto. Cambia con: hive-code mode set approval|auto`
}
