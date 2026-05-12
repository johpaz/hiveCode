/**
 * Config loader — stubbed to fix build.
 * TODO: Implement full config loading from ~/.hive/config.json or env vars.
 */

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
  models?: { defaultProvider?: string; defaults?: Record<string, string> }
}

export interface Binding {
  host: string
  port: number
}

export function getHiveDir(): string {
  return process.env.HIVE_HOME || `${process.env.HOME || "/tmp"}/.hive`
}

export async function loadConfig(): Promise<Config> {
  // TODO: Load from ~/.hive/config.json
  return {
    port: Number(process.env.HIVE_PORT) || 18790,
    host: process.env.HIVE_HOST || "0.0.0.0",
  }
}
