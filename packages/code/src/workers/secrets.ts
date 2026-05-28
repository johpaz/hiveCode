/**
 * Secret management for workers.
 *
 * Reads API keys exclusively from Bun.secrets (OS keystore).
 * Distributes secrets to workers via setEnvironmentData + postMessage fallback.
 *
 * No env var fallbacks — all secrets must be stored via:
 *   bunx @johpaz/hivecode secret set provider.<id>
 */

import { getProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

const logPrefix = "[secrets]"

export interface HiveSecrets {
  provider: string
  model: string
  apiKeys: Record<string, string>
  distributedAt: number
}

function providerEnvKey(providerId: string): string {
  return `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`
}

/**
 * Load enabled provider keys from the OS keystore, translating the canonical
 * provider.<id> storage key to the env-style key expected inside workers.
 * Each provider uses its own independent identifier — no sharing between providers.
 */
export async function loadSecrets(): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {}
  const missing: string[] = []
  const providerRows = getDb().query(
    "SELECT id FROM providers WHERE enabled = 1 ORDER BY id"
  ).all() as { id: string }[]

  for (const { id } of providerRows) {
    const value = await getProviderApiKey(id)
    if (value) {
      secrets[providerEnvKey(id)] = value
    } else {
      missing.push(id)
    }
  }

  const found = Object.keys(secrets).length
  if (found > 0) {
    console.info(`${logPrefix} ✅ Loaded ${found} provider key(s) from Bun.secrets (OS keystore)`)
  } else {
    console.warn(`${logPrefix} ⚠️  No provider keys found in Bun.secrets. Configure one with /provider add`)
  }

  if (missing.length > 0) {
    console.info(`${logPrefix} ℹ️  Enabled providers without a key in Bun.secrets: ${missing.join(", ")}`)
  }

  return secrets
}

/**
 * Get a specific API key for a provider.
 */
export function getApiKey(secrets: Record<string, string>, provider: string): string {
  const envKey = providerEnvKey(provider)
  return secrets[envKey] || secrets["LLM_API_KEY"] || ""
}

/**
 * Distribute secrets to workers via setEnvironmentData.
 * Must be called BEFORE creating workers.
 */
export function distributeSecrets(secrets: Record<string, string>): boolean {
  try {
    // Try Bun's setEnvironmentData first (bun:worker or node:worker_threads)
    const wt = require("bun:worker") as any
    if (wt && typeof wt.setEnvironmentData === "function") {
      wt.setEnvironmentData("HIVE_CODE_SECRETS", secrets)
      console.info(`${logPrefix} ✅ Secrets distributed via bun:worker.setEnvironmentData`)
      return true
    }
  } catch {
    // bun:worker not available
  }

  try {
    const { setEnvironmentData } = require("node:worker_threads") as any
    if (typeof setEnvironmentData === "function") {
      setEnvironmentData("HIVE_CODE_SECRETS", secrets)
      console.info(`${logPrefix} ✅ Secrets distributed via node:worker_threads.setEnvironmentData`)
      return true
    }
  } catch {
    // node:worker_threads not available
  }

  console.warn(
    `${logPrefix} ⚠️  setEnvironmentData not available — secrets will be passed via postMessage (less secure)`
  )
  return false
}

/**
 * Read secrets in a worker context.
 * Tries getEnvironmentData first, falls back to postMessage secrets.
 */
export function readWorkerSecrets(): Record<string, string> | undefined {
  try {
    const wt = require("bun:worker") as any
    if (wt && typeof wt.getEnvironmentData === "function") {
      const data = wt.getEnvironmentData("HIVE_CODE_SECRETS")
      if (data && typeof data === "object") return data as Record<string, string>
    }
  } catch {
    // bun:worker not available
  }

  try {
    const { getEnvironmentData } = require("node:worker_threads") as any
    if (typeof getEnvironmentData === "function") {
      const data = getEnvironmentData("HIVE_CODE_SECRETS")
      if (data && typeof data === "object") return data as Record<string, string>
    }
  } catch {
    // node:worker_threads not available
  }

  return undefined
}
