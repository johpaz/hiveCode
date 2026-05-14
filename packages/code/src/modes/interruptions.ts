/**
 * Automatic Interruptions — detect dangerous operations and block them.
 *
 * SPEC §6.3: The following actions ALWAYS require user confirmation:
 *   - DROP TABLE / DELETE FROM without WHERE
 *   - Push direct to main/master
 *   - bun add (new dependency)
 *   - Modify .env / secrets / production configs
 *   - Execute script downloaded from internet
 *   - CRITICAL severity finding from Security Coordinator
 */

import type { WorkerToManagerMessage } from "../workers/types"
import { logger } from "@johpaz/hivecode-core/utils/logger"

const log = logger.child("interruptions")

/** Patterns that trigger automatic interruption */
const DANGEROUS_SQL_PATTERNS = [
  /drop\s+table/i,
  /delete\s+from\s+\w+\s*(?!.*where)/i,
  /truncate\s+table/i,
]

const DANGEROUS_GIT_PATTERNS = [
  /git\s+push\s+.*main/,
  /git\s+push\s+.*master/,
  /git\s+push\s+-f/,
  /git\s+push\s+--force/,
]

const DANGEROUS_FILE_PATTERNS = [
  /\.env$/,
  /Bun\.secrets/,
  /config\.production/,
  /config\.prod/,
]

const DANGEROUS_SHELL_PATTERNS = [
  /bun\s+add/i,
  /npm\s+install/i,
  /curl\s+.*\|/,
  /wget\s+.*\|/,
  /bash\s+-c\s+.*curl/,
]

export interface InterruptionResult {
  blocked: boolean
  reason: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM"
}

/**
 * Check if a tool call triggers an automatic interruption.
 */
export function checkAutomaticInterruption(msg: WorkerToManagerMessage): InterruptionResult | null {
  if (msg.type !== "TOOL_CALL" || !msg.toolName) return null

  const toolName = msg.toolName
  const args = JSON.stringify(msg.toolArgs || {})

  // Check SQL patterns
  if (toolName === "shell_executor") {
    const cmd = (msg.toolArgs?.cmd as string) || ""

    for (const pattern of DANGEROUS_SQL_PATTERNS) {
      if (pattern.test(cmd)) {
        log.warn(`[interruptions] BLOCKED dangerous SQL: ${cmd.slice(0, 100)}`)
        return {
          blocked: true,
          reason: `Dangerous SQL detected: ${cmd.match(pattern)?.[0]}. This requires explicit user confirmation.`,
          severity: "CRITICAL",
        }
      }
    }

    for (const pattern of DANGEROUS_GIT_PATTERNS) {
      if (pattern.test(cmd)) {
        log.warn(`[interruptions] BLOCKED dangerous git push: ${cmd.slice(0, 100)}`)
        return {
          blocked: true,
          reason: `Push to main/master or force push detected: ${cmd.match(pattern)?.[0]}. This requires explicit user confirmation.`,
          severity: "HIGH",
        }
      }
    }

    for (const pattern of DANGEROUS_SHELL_PATTERNS) {
      if (pattern.test(cmd)) {
        log.warn(`[interruptions] BLOCKED dangerous shell: ${cmd.slice(0, 100)}`)
        return {
          blocked: true,
          reason: `Potentially dangerous shell command detected: ${cmd.match(pattern)?.[0]}. This requires explicit user confirmation.`,
          severity: "HIGH",
        }
      }
    }
  }

  // Check file operations on sensitive files (write, edit, AND delete)
  if (toolName === "fs_write" || toolName === "fs_edit" || toolName === "fs_delete") {
    const filePath = (msg.toolArgs?.path as string) || ""

    for (const pattern of DANGEROUS_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        const operation = toolName === "fs_delete" ? "deletion" : "modification"
        log.warn(`[interruptions] BLOCKED sensitive file ${operation}: ${filePath}`)
        return {
          blocked: true,
          reason: `${operation.charAt(0).toUpperCase() + operation.slice(1)} of sensitive file detected: ${filePath}. This requires explicit user confirmation.`,
          severity: toolName === "fs_delete" ? "CRITICAL" : "HIGH",
        }
      }
    }
  }

  // CRITICAL findings from Security Coordinator
  if (msg.coordinator === "security" && args.includes("CRITICAL")) {
    log.warn(`[interruptions] CRITICAL security finding from ${msg.coordinator}`)
    return {
      blocked: true,
      reason: "CRITICAL security finding detected. Task paused until user reviews.",
      severity: "CRITICAL",
    }
  }

  return null
}
