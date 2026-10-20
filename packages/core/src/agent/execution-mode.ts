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
  "code_lint", "code_test", "code_build",
  "git_commit", "git_push",
  "cron.create", "cron.update", "cron.pause", "cron.resume",
  "cron.delete", "cron.trigger",
  // Delegating research/planning is allowed; children still enforce this same mode.
  "agent_create", "agent_archive", "task_delegate_code",
  "memory_delete",
])

const CONFIRM_REQUIRED_TOOLS = new Set([
  "fs_write", "fs_edit", "fs_delete",
  "git_commit",
  "cron.delete", "agent_archive",
])

export function canExecuteTool(toolName: string, mode?: ExecutionMode): boolean {
  const currentMode = mode ?? getExecutionMode()
  if (currentMode === "plan" && PLAN_BLOCKED_TOOLS.has(toolName)) return false
  return true
}

/**
 * The y/N prompt for a confirmable tool reads `process.stdin`. Inside the TUI the
 * keyboard belongs to the TUI process, so that prompt can never be answered and
 * the task hangs forever. Only prompt when a person can actually answer.
 */
export function canPromptForConfirmation(): boolean {
  return process.env.HIVECODE_TUI !== "1" && process.stdin.isTTY === true
}

export function requiresConfirmation(toolName: string): boolean {
  return CONFIRM_REQUIRED_TOOLS.has(toolName)
}

/**
 * Commands that change files or repository history. The shell is how an agent could write
 * around a declined `fs_write`, so in `approval` these ask like the file tools do. Reading,
 * testing and building (`ls`, `cat`, `git status`, `bun test`, `tsc`) do not, or every
 * verification step would stop to ask.
 */
const MUTATING_COMMANDS = new Set([
  "rm", "rmdir", "unlink", "mv", "cp", "touch", "ln", "truncate", "shred", "dd", "install",
  "chmod", "chown", "chgrp", "tee", "patch",
])
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "eval", "xargs", "sudo", "env", "nohup", "time", "command"])
const MUTATING_GIT = new Set([
  "commit", "push", "reset", "clean", "rm", "mv", "rebase", "merge", "cherry-pick", "revert",
  "checkout", "switch", "restore", "stash", "am", "apply", "pull",
])

export function shellCommandMutates(command: string): boolean {
  if (typeof command !== "string" || !command.trim()) return false
  // A redirection writes a file; `2>&1`, `>&2` and `> /dev/null` do not.
  const withoutNoise = command
    .replace(/\d*>&\d+/g, "")
    .replace(/\d*>>?\s*\/dev\/null/g, "")
  if (/(^|[^<>=!-])>>?(?![>&=])/.test(withoutNoise)) return true

  for (const segment of command.split(/&&|\|\||;|\||\n|\$\(|`|\(|\)/)) {
    const words = segment.trim().replace(/^["']|["']$/g, "").split(/\s+/)
      .filter(word => word && !/^\w+=/.test(word))
    let i = 0
    while (i < words.length && SHELLS.has(words[i])) i++
    const head = (words[i] ?? "").replace(/^.*\//, "").replace(/^["']|["']$/g, "")
    if (!head) continue
    if (head === "-c") continue
    if (MUTATING_COMMANDS.has(head)) return true
    if (head === "sed" || head === "perl") {
      if (words.slice(i + 1).some(word => /^-[a-zA-Z]*i/.test(word) || word === "--in-place")) return true
    }
    if (head === "find" && words.some(word => word === "-delete" || word === "-exec" || word === "-execdir")) return true
    if (head === "git") {
      const sub = words.slice(i + 1).find(word => !word.startsWith("-"))
      if (sub && MUTATING_GIT.has(sub)) return true
      if (sub === "branch" && words.some(word => /^-[dD]$|^--delete$/.test(word))) return true
      if (sub === "tag" && words.some(word => /^-d$|^--delete$/.test(word))) return true
    }
    if ((head === "npm" || head === "bun" || head === "pnpm" || head === "yarn") && words.includes("publish")) return true
  }
  // `bash -c "rm x"`: the quoted body is a command line of its own.
  const inner = /\b(?:bash|sh|zsh)\s+-c\s+(["'])([\s\S]*)\1/.exec(command)
  return !!inner && shellCommandMutates(inner[2])
}

/** Whether this particular call needs the person's yes in `approval` mode. */
export function callRequiresConfirmation(toolName: string, args: unknown): boolean {
  if (requiresConfirmation(toolName)) return true
  if (toolName !== "shell_executor") return false
  let parsed: unknown = args
  if (typeof args === "string") {
    // Arguments that do not even parse cannot be judged: ask rather than guess.
    try { parsed = JSON.parse(args) } catch { return true }
  }
  // The tool's own parameter is `cmd`; `command` is accepted too (see tools/cli/index.ts).
  const fields = parsed as { cmd?: unknown; command?: unknown } | null
  const command = fields?.cmd ?? fields?.command
  if (typeof command === "string") return shellCommandMutates(command)
  // A call with no readable command cannot be judged: ask rather than guess.
  return true
}

export function filterToolsByMode<T extends { name: string }>(
  tools: T[], mode?: ExecutionMode
): T[] {
  const currentMode = mode ?? getExecutionMode()
  if (currentMode !== "plan") return tools
  return tools.filter(t => !PLAN_BLOCKED_TOOLS.has(t.name))
}

export function getBlockReason(toolName: string): string {
  return `[PERMISSION DENIED] '${toolName}' requiere modo approval o auto. Cambia con: hivecode mode set approval|auto`
}
