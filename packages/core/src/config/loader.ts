/**
 * Config loader — stubbed to fix build.
 * TODO: Implement full config loading from ~/.hivecode/config.json or env vars.
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
  models?: { 
    defaultProvider?: string; 
    defaults?: Record<string, string>;
    providers?: Record<string, any>;
    llm?: Record<string, any>;
    embeddings?: Record<string, any>;
  }
  hooks?: { scripts?: string[] }
  bindings?: Binding[]
  agent?: { defaultAgentId?: string; baseDir?: string }
  workspace?: { path?: string; activeProject?: string }
  [key: string]: any
}

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

export function getHiveDir(): string {
  return process.env.HIVE_HOME || `${process.env.HOME || "/tmp"}/.hivecode`
}

export function loadConfig(): Config {
  // TODO: Load from ~/.hivecode/config.json
  return {
    port: Number(process.env.HIVE_PORT) || 16120,
    host: process.env.HIVE_HOST || "0.0.0.0",
  }
}
