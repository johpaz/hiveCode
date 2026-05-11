/**
 * Secret management for workers.
 *
 * Reads API keys from Bun.secrets (OS keystore) first,
 * falls back to Bun.env with a loud warning.
 *
 * Distributes secrets to workers via setEnvironmentData + postMessage fallback.
 */

const logPrefix = "[secrets]"

export interface HiveSecrets {
  provider: string
  model: string
  apiKeys: Record<string, string>
  distributedAt: number
}

/**
 * Read a secret from Bun.secrets if available.
 */
function readBunSecret(name: string): string | undefined {
  try {
    const bunSecrets = (Bun as any).secrets
    if (bunSecrets && typeof bunSecrets.get === "function") {
      return bunSecrets.get(name) || undefined
    }
  } catch {
    // Bun.secrets not available on this platform/Bun version
  }
  return undefined
}

/**
 * List all secret names from Bun.secrets.
 */
function listBunSecrets(): string[] {
  try {
    const bunSecrets = (Bun as any).secrets
    if (bunSecrets && typeof bunSecrets.list === "function") {
      return bunSecrets.list() || []
    }
  } catch {
    // Bun.secrets not available
  }
  return []
}

const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OLLAMA_API_KEY",
  "DEEPSEEK_API_KEY",
  "KIMI_API_KEY",
  "MISTRAL_API_KEY",
  "NVIDIA_API_KEY",
  "QWEN_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_API_KEY",
]

/**
 * Load all secrets from Bun.secrets and env vars.
 * Bun.secrets takes precedence.
 */
export function loadSecrets(): Record<string, string> {
  const secrets: Record<string, string> = {}
  let bunCount = 0
  let envCount = 0

  // 1. Try Bun.secrets (OS keystore) — preferred
  for (const keyName of listBunSecrets()) {
    const value = readBunSecret(keyName)
    if (value) {
      secrets[keyName] = value
      bunCount++
    }
  }

  // 2. Fallback to env vars for known provider keys
  for (const envKey of PROVIDER_ENV_KEYS) {
    if (secrets[envKey]) continue // already from Bun.secrets
    const envValue = process.env[envKey]
    if (envValue) {
      secrets[envKey] = envValue
      envCount++
    }
  }

  // 3. HIVE_COORDINATOR_PROVIDER / MODEL
  const coordinatorProvider =
    readBunSecret("HIVE_COORDINATOR_PROVIDER") || process.env.HIVE_COORDINATOR_PROVIDER || "anthropic"
  const coordinatorModel =
    readBunSecret("HIVE_COORDINATOR_MODEL") || process.env.HIVE_COORDINATOR_MODEL || "claude-sonnet-4-6"

  // Log summary (never log values)
  if (bunCount > 0) {
    console.info(`${logPrefix} ✅ Loaded ${bunCount} key(s) from Bun.secrets (OS keystore)`)
  }
  if (envCount > 0) {
    console.warn(
      `${logPrefix} ⚠️  Loaded ${envCount} key(s) from env vars. Consider migrating to Bun.secrets for better security:` +
        `\n   bunx @johpaz/hive-code secret set <name>`
    )
  }
  if (bunCount === 0 && envCount === 0) {
    console.error(
      `${logPrefix} ❌ No API keys found. Set them via:\n` +
        `   bunx @johpaz/hive-code secret set <name>   (recommended)\n` +
        `   or export <PROVIDER>_API_KEY=<key>          (fallback)`
    )
  }

  return secrets
}

/**
 * Get a specific API key for a provider.
 */
export function getApiKey(secrets: Record<string, string>, provider: string): string {
  const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`
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
