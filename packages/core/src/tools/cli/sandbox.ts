/**
 * Sandbox Engine — OS-level process isolation for shell commands.
 *
 * Uses bubblewrap on Linux and sandbox-exec (Seatbelt) on macOS.
 * Provides filesystem and network isolation at the kernel level.
 *
 * Inspired by Claude Code's sandboxing architecture.
 */

import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { logger } from "../../utils/logger.ts"
import { buildBwrapCommand, isBwrapAvailable } from "./sandbox-bwrap.ts"
import { buildSeatbeltCommand, isSeatbeltAvailable } from "./sandbox-seatbelt.ts"

const log = logger.child("sandbox")

export type SandboxProvider = "bwrap" | "seatbelt" | null
export type SandboxMode = "auto-allow" | "permissions"

export interface SandboxFilesystemConfig {
  allowWrite: string[]
  denyWrite: string[]
  denyRead: string[]
  allowRead: string[]
}

export interface SandboxNetworkConfig {
  enabled: boolean
  allowedDomains: string[]
}

export interface SandboxConfig {
  enabled: boolean
  mode: SandboxMode
  workspace: string
  filesystem: SandboxFilesystemConfig
  network: SandboxNetworkConfig
  excludedCommands: string[]
  failIfUnavailable: boolean
}

export interface SandboxResult {
  ok: boolean
  provider: SandboxProvider
  command: string[]
  error?: string
}

/**
 * Detect which sandbox provider is available on this system.
 * Returns 'bwrap' on Linux, 'seatbelt' on macOS, or null if none available.
 */
export function detectSandboxProvider(): SandboxProvider {
  const platform = os.platform()

  if (platform === "linux") {
    if (isBwrapAvailable()) {
      return "bwrap"
    }
    log.warn("[sandbox] bubblewrap not found on Linux")
    return null
  }

  if (platform === "darwin") {
    if (isSeatbeltAvailable()) {
      return "seatbelt"
    }
    log.warn("[sandbox] sandbox-exec not found on macOS")
    return null
  }

  log.warn(`[sandbox] Unsupported platform: ${platform}`)
  return null
}

/**
 * Check if any sandbox provider is available on this system.
 */
export function isSandboxAvailable(): boolean {
  return detectSandboxProvider() !== null
}

/**
 * Check if a command should be excluded from sandboxing.
 * Some tools (docker, kubectl) need full host access and are incompatible with sandboxing.
 */
export function shouldExcludeCommand(cmd: string, excludedCommands: string[]): boolean {
  const trimmed = cmd.trim()
  for (const pattern of excludedCommands) {
    if (trimmed.startsWith(pattern)) {
      return true
    }
  }
  return false
}

/**
 * Build a sandboxed command array for Bun.spawn().
 *
 * Returns the full command array that wraps the original command
 * with sandbox isolation (bwrap or sandbox-exec).
 */
export function buildSandboxCommand(
  cmd: string,
  config: SandboxConfig
): SandboxResult {
  if (!config.enabled) {
    return { ok: false, provider: null, command: [], error: "Sandbox not enabled" }
  }

  if (shouldExcludeCommand(cmd, config.excludedCommands)) {
    return { ok: false, provider: null, command: [], error: "Command excluded from sandbox" }
  }

  const provider = detectSandboxProvider()
  if (!provider) {
    if (config.failIfUnavailable) {
      return {
        ok: false,
        provider: null,
        command: [],
        error: "No sandbox provider available and failIfUnavailable is true",
      }
    }
    return { ok: false, provider: null, command: [], error: "No sandbox provider available, falling back to unsandboxed execution" }
  }

  log.info(`[sandbox] Using provider: ${provider} for command: ${cmd.slice(0, 80)}...`)

  let sandboxedCmd: string[]

  switch (provider) {
    case "bwrap":
      sandboxedCmd = buildBwrapCommand(cmd, config)
      break
    case "seatbelt":
      sandboxedCmd = buildSeatbeltCommand(cmd, config)
      break
    default:
      return { ok: false, provider: null, command: [], error: `Unknown provider: ${provider}` }
  }

  return { ok: true, provider, command: sandboxedCmd }
}

/**
 * Resolve a path against the workspace, expanding ~ and making it absolute.
 */
export function resolveSandboxPath(p: string, workspace: string): string {
  if (p.startsWith("~")) {
    p = path.join(os.homedir(), p.slice(1))
  }
  if (!path.isAbsolute(p)) {
    p = path.resolve(workspace, p)
  }
  return path.normalize(p)
}

/**
 * Build the filesystem config with workspace as default allowWrite.
 */
export function buildFilesystemConfig(
  workspace: string,
  userConfig?: Partial<SandboxFilesystemConfig>
): SandboxFilesystemConfig {
  return {
    allowWrite: [workspace, ...(userConfig?.allowWrite || [])],
    denyWrite: userConfig?.denyWrite || [],
    denyRead: userConfig?.denyRead || [],
    allowRead: userConfig?.allowRead || [],
  }
}

/**
 * Build the network config with defaults.
 */
export function buildNetworkConfig(
  userConfig?: Partial<SandboxNetworkConfig>
): SandboxNetworkConfig {
  return {
    enabled: userConfig?.enabled ?? true,
    allowedDomains: userConfig?.allowedDomains || [],
  }
}
