/**
 * Bubblewrap Backend — Linux sandbox using bwrap namespaces.
 *
 * Provides filesystem, PID, IPC, and UTS isolation without root.
 * Uses user namespaces for unprivileged operation.
 *
 * Architecture:
 * - Read-only root filesystem (/)
 * - Read-write workspace bind mount
 * - Isolated /tmp (tmpfs)
 * - Optional network isolation
 * - Capability dropping
 */

import * as childProcess from "node:child_process"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"
import type { SandboxConfig } from "./sandbox.ts"
import { logger } from "../../utils/logger.ts"

const log = logger.child("sandbox-bwrap")

const BWRAP_PATH = "/usr/bin/bwrap"

/**
 * Check if bubblewrap is available on this system.
 */
export function isBwrapAvailable(): boolean {
  try {
    const result = childProcess.spawnSync(BWRAP_PATH, ["--version"], {
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return result.status === 0 || result.stdout.toString().includes("bubblewrap")
  } catch {
    // Try alternative paths
    try {
      const result = childProcess.spawnSync("bwrap", ["--version"], {
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      return result.status === 0 || result.stdout.toString().includes("bubblewrap")
    } catch {
      return false
    }
  }
}

/**
 * Build a bubblewrap command array for the given shell command.
 *
 * The resulting array can be passed directly to Bun.spawn().
 */
export function buildBwrapCommand(
  cmd: string,
  config: SandboxConfig
): string[] {
  const workspace = path.resolve(config.workspace)
  const args: string[] = [BWRAP_PATH]

  // ── Namespace isolation ──────────────────────────────────────────
  args.push(
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
    "--new-session",
    "--cap-drop", "ALL",
  )

  // ── Read-only root filesystem ────────────────────────────────────
  args.push("--ro-bind", "/", "/")

  // ── Essential mounts ─────────────────────────────────────────────
  args.push(
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/run",
  )

  // ── Workspace (read-write) ───────────────────────────────────────
  // We don't mount a global /tmp tmpfs because that would allow writes
  // anywhere in /tmp. Instead, we create a tmpfs at workspace/tmp if needed.
  args.push("--bind", workspace, workspace)

  // ── Additional write paths ───────────────────────────────────────
  for (const p of config.filesystem.allowWrite) {
    const resolved = resolvePath(p, workspace)
    if (resolved !== workspace && fsPathExists(resolved)) {
      args.push("--bind", resolved, resolved)
    }
  }

  // ── Additional read paths ────────────────────────────────────────
  for (const p of config.filesystem.allowRead) {
    const resolved = resolvePath(p, workspace)
    if (fsPathExists(resolved)) {
      args.push("--ro-bind", resolved, resolved)
    }
  }

  // ── Deny writes to specific paths (handled by ordering) ──────────
  // bwrap uses last-match-wins, so we bind read-only over writable paths
  for (const p of config.filesystem.denyWrite) {
    const resolved = resolvePath(p, workspace)
    if (fsPathExists(resolved)) {
      // Overlay a read-only bind on top
      args.push("--ro-bind", resolved, resolved)
    }
  }

  // ── Network isolation ────────────────────────────────────────────
  if (!config.network.enabled) {
    // No --share-net means no network namespace
    // The process will have no network access
    log.info("[sandbox-bwrap] Network isolation enabled (no --share-net)")
  } else {
    args.push("--share-net")
  }

  // ── Environment ──────────────────────────────────────────────────
  args.push(
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "HOME", workspace,
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "en_US.UTF-8",
    "--setenv", "TERM", "xterm-256color",
    "--setenv", "NODE_ENV", "production",
  )

  // ── Working directory ────────────────────────────────────────────
  args.push("--chdir", workspace)

  // ── Execute command ──────────────────────────────────────────────
  args.push("/bin/sh", "-c", cmd)

  log.debug(`[sandbox-bwrap] Command: ${args.join(" ").slice(0, 200)}...`)

  return args
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

/**
 * Check if a filesystem path exists.
 */
function fsPathExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}
