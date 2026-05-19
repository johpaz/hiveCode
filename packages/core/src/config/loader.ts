/**
 * Config loader — loads from ~/.hivecode/config.json with Zod validation.
 *
 * Precedence: config.json → env overrides (HIVE_HOME, HIVE_PORT, HIVE_HOST only)
 * Secrets are managed exclusively via Bun.secrets (OS keystore).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { configSchema } from "./schema"

export interface Binding {
  agentId: string
  match: {
    channel?: string
    accountId?: string
    peer?: { id?: string; kind?: string }
    guildId?: string
    roles?: string[]
    teamId?: string
  }
}

export interface Config {
  port?: number
  host?: string
  database?: { path?: string }
  security?: { warnOnInsecureConfig?: boolean; authToken?: string }
  providers?: Record<string, any>
  channels?: Record<string, any>
  skills?: any
  cron?: any
  tts?: any
  vision?: any
  mcp?: { servers?: Record<string, any> }
  gateway?: { port?: number; host?: string; pidFile?: string }
  logging?: { level?: string }
  models?: {
    defaultProvider?: string
    defaults?: Record<string, string>
    providers?: Record<string, any>
    llm?: Record<string, any>
    embeddings?: Record<string, any>
  }
  hooks?: { scripts?: string[] }
  bindings?: Binding[]
  agent?: { defaultAgentId?: string; baseDir?: string }
  workspace?: { path?: string; activeProject?: string }
  sandbox?: {
    enabled?: boolean
    mode?: 'auto-allow' | 'permissions'
    filesystem?: {
      allowWrite?: string[]
      denyWrite?: string[]
      denyRead?: string[]
      allowRead?: string[]
    }
    network?: {
      enabled?: boolean
      allowedDomains?: string[]
    }
    excludedCommands?: string[]
    failIfUnavailable?: boolean
  }
  [key: string]: any
}

let cachedConfig: Config | null = null

const CONFIG_FILENAME = "config.json"

export function getHiveDir(): string {
  return process.env.HIVE_HOME || `${process.env.HOME || "/tmp"}/.hivecode`
}

function getConfigPath(): string {
  return join(getHiveDir(), CONFIG_FILENAME)
}

function readConfigFile(): Record<string, unknown> | null {
  const configPath = getConfigPath()
  try {
    if (!existsSync(configPath)) return null
    const raw = readFileSync(configPath, "utf-8")
    return JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    console.warn(`[config] Failed to read ${configPath}: ${(err as Error).message}`)
    return null
  }
}

function applyEnvOverrides(config: Config): Config {
  const envPort = process.env.HIVE_PORT
  if (envPort) config.port = Number(envPort)
  const envHost = process.env.HIVE_HOST
  if (envHost) config.host = envHost

  const envSandbox = process.env.HIVE_SANDBOX
  if (envSandbox) {
    config.sandbox = config.sandbox || {}
    if (envSandbox === 'true' || envSandbox === '1') {
      config.sandbox.enabled = true
    } else if (envSandbox === 'false' || envSandbox === '0') {
      config.sandbox.enabled = false
    }
  }

  const envSandboxMode = process.env.HIVE_SANDBOX_MODE
  if (envSandboxMode === 'auto-allow' || envSandboxMode === 'permissions') {
    config.sandbox = config.sandbox || {}
    config.sandbox.mode = envSandboxMode
  }

  return config
}

const DEFAULTS: Config = {
  port: 16120,
  host: "0.0.0.0",
  logging: { level: "info" },
  security: { warnOnInsecureConfig: true },
}

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig

  const fileConfig = readConfigFile() ?? {}

  if (Object.keys(fileConfig).length > 0) {
    const parsed = configSchema.safeParse(fileConfig)
    if (!parsed.success) {
      console.warn(`[config] Validation errors in ${getConfigPath()}:`)
      for (const issue of parsed.error.issues) {
        console.warn(`  - ${issue.path.join(".")}: ${issue.message}`)
      }
    }
  }

  const config: Config = { ...DEFAULTS, ...fileConfig }
  applyEnvOverrides(config)

  cachedConfig = config
  return config
}

export function resetConfig(): void {
  cachedConfig = null
}

export function saveConfig(config: Config): void {
  const hiveDir = getHiveDir()
  if (!existsSync(hiveDir)) mkdirSync(hiveDir, { recursive: true })

  const validated = configSchema.parse(config)
  const configPath = getConfigPath()
  writeFileSync(configPath, JSON.stringify(validated, null, 2), "utf-8")

  cachedConfig = validated as Config
}

export { configSchema }