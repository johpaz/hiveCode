/**
 * Seatbelt Backend — macOS sandbox using sandbox-exec.
 *
 * Uses Apple's Seatbelt (sandbox_init) for process isolation.
 * Profile is based on Chrome's renderer sandbox pattern.
 *
 * Architecture:
 * - Default deny all operations
 * - Allow read from system directories (/usr, /bin, /lib, /System)
 * - Allow read/write in workspace
 * - Allow read/write in /tmp
 * - Optional network access
 */

import * as childProcess from "node:child_process"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"
import type { SandboxConfig } from "./sandbox.ts"
import { logger } from "../../utils/logger.ts"

const log = logger.child("sandbox-seatbelt")

const SEATBELT_EXEC = "/usr/bin/sandbox-exec"

/**
 * Check if sandbox-exec is available on this system.
 */
export function isSeatbeltAvailable(): boolean {
  try {
    const result = childProcess.spawnSync(SEATBELT_EXEC, ["-p", "(version 1)", "--", "/usr/bin/true"], {
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return result.status === 0 || result.stderr.toString().includes("sandbox-exec")
  } catch {
    return false
  }
}

/**
 * Build a sandbox-exec command array for the given shell command.
 *
 * Generates a dynamic Seatbelt profile and passes it via -p flag.
 */
export function buildSeatbeltCommand(
  cmd: string,
  config: SandboxConfig
): string[] {
  const workspace = path.resolve(config.workspace)
  const profile = generateSeatbeltProfile(config)
  const profilePath = writeProfileToTempFile(profile)

  log.debug(`[sandbox-seatbelt] Profile written to: ${profilePath}`)

  const args = [
    SEATBELT_EXEC,
    "-f", profilePath,
    "--",
    "/bin/sh", "-c", cmd,
  ]

  log.debug(`[sandbox-seatbelt] Command: ${args.join(" ").slice(0, 200)}...`)

  return args
}

/**
 * Generate a Seatbelt profile string based on the sandbox config.
 *
 * Profile semantics:
 * - Default deny (deny default)
 * - Explicit allow for system paths (read-only)
 * - Explicit allow for workspace (read-write)
 * - Explicit allow for /tmp (read-write)
 * - Network access controlled by config
 */
function generateSeatbeltProfile(config: SandboxConfig): string {
  const workspace = path.resolve(config.workspace)
  const lines: string[] = []

  lines.push("(version 1)")
  lines.push("")
  lines.push("; Default deny — anything not explicitly allowed is blocked")
  lines.push("(deny default)")
  lines.push("")

  // ── System read access ──────────────────────────────────────────
  lines.push("; System directories (read-only)")
  lines.push("(allow file-read* (subpath \"/usr\"))")
  lines.push("(allow file-read* (subpath \"/bin\"))")
  lines.push("(allow file-read* (subpath \"/sbin\"))")
  lines.push("(allow file-read* (subpath \"/lib\"))")
  lines.push("(allow file-read* (subpath \"/Library\"))")
  lines.push("(allow file-read* (subpath \"/System\"))")
  lines.push("(allow file-read* (subpath \"/private/var\"))")
  lines.push("")

  // ── Essential device access ─────────────────────────────────────
  lines.push("; Essential devices")
  lines.push("(allow file-read* (subpath \"/dev/null\"))")
  lines.push("(allow file-read* (subpath \"/dev/zero\"))")
  lines.push("(allow file-read* (subpath \"/dev/random\"))")
  lines.push("(allow file-read* (subpath \"/dev/urandom\"))")
  lines.push("")

  // ── /tmp read-write ─────────────────────────────────────────────
  lines.push("; Temporary directory (read-write)")
  lines.push("(allow file-read* (subpath \"/tmp\"))")
  lines.push("(allow file-write* (subpath \"/tmp\"))")
  lines.push("")

  // ── Workspace read-write ────────────────────────────────────────
  lines.push(`; Workspace (read-write): ${workspace}`)
  lines.push(`(allow file-read* (subpath "${escapeSeatbeltPath(workspace)}"))`)
  lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(workspace)}"))`)
  lines.push("")

  // ── Additional read paths ───────────────────────────────────────
  for (const p of config.filesystem.allowRead) {
    const resolved = resolvePath(p, workspace)
    lines.push(`(allow file-read* (subpath "${escapeSeatbeltPath(resolved)}"))`)
  }
  if (config.filesystem.allowRead.length > 0) {
    lines.push("")
  }

  // ── Additional write paths ──────────────────────────────────────
  for (const p of config.filesystem.allowWrite) {
    const resolved = resolvePath(p, workspace)
    if (resolved !== workspace) {
      lines.push(`(allow file-read* (subpath "${escapeSeatbeltPath(resolved)}"))`)
      lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(resolved)}"))`)
    }
  }
  if (config.filesystem.allowWrite.length > 0) {
    lines.push("")
  }

  // ── Deny read paths ─────────────────────────────────────────────
  for (const p of config.filesystem.denyRead) {
    const resolved = resolvePath(p, workspace)
    lines.push(`(deny file-read* (subpath "${escapeSeatbeltPath(resolved)}"))`)
  }
  if (config.filesystem.denyRead.length > 0) {
    lines.push("")
  }

  // ── Deny write paths ────────────────────────────────────────────
  for (const p of config.filesystem.denyWrite) {
    const resolved = resolvePath(p, workspace)
    lines.push(`(deny file-write* (subpath "${escapeSeatbeltPath(resolved)}"))`)
  }
  if (config.filesystem.denyWrite.length > 0) {
    lines.push("")
  }

  // ── Process execution ───────────────────────────────────────────
  lines.push("; Process execution")
  lines.push("(allow process-exec*)")
  lines.push("(allow process-fork)")
  lines.push("(allow signal (target same-sandbox))")
  lines.push("")

  // ── System operations ───────────────────────────────────────────
  lines.push("; System operations")
  lines.push("(allow sysctl-read)")
  lines.push("(allow file-read-metadata)")
  lines.push("")

  // ── Network access ──────────────────────────────────────────────
  if (config.network.enabled) {
    lines.push("; Network access (enabled)")
    lines.push("(allow network-outbound)")
    lines.push("(allow network-inbound)")
    lines.push("(allow socket-filter-control)")
  } else {
    lines.push("; Network access (DENIED)")
    lines.push("(deny network-outbound)")
    lines.push("(deny network-inbound)")
    lines.push("(deny socket-outbound)")
    lines.push("(deny socket-inbound)")
  }

  return lines.join("\n")
}

/**
 * Escape a path for use in a Seatbelt profile.
 * Special characters need to be escaped in Seatbelt syntax.
 */
function escapeSeatbeltPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
}

/**
 * Write the profile to a temporary file.
 * Returns the file path.
 */
function writeProfileToTempFile(profile: string): string {
  const tmpDir = os.tmpdir()
  const profilePath = path.join(tmpDir, `hive-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}.sb`)

  fs.writeFileSync(profilePath, profile, "utf-8")

  // Clean up old profile files (older than 1 hour)
  try {
    const entries = fs.readdirSync(tmpDir)
    for (const entry of entries) {
      if (entry.startsWith("hive-sandbox-") && entry.endsWith(".sb")) {
        const filePath = path.join(tmpDir, entry)
        const stat = fs.statSync(filePath)
        if (Date.now() - stat.mtimeMs > 3600_000) {
          fs.unlinkSync(filePath)
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  return profilePath
}

/**
 * Resolve a path relative to workspace or expand ~.
 */
function resolvePath(p: string, workspace: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1))
  }
  if (!path.isAbsolute(p)) {
    return path.resolve(workspace, p)
  }
  return path.normalize(p)
}
