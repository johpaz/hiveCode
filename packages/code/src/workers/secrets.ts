/**
 * Secret management for workers.
 *
 * Reads API keys exclusively from Bun.secrets (OS keystore).
 * Distributes secrets to workers via setEnvironmentData + postMessage fallback.
 *
 * No env var fallbacks — all secrets must be stored via:
 *   bunx @johpaz/hivecode secret set <name>
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

const PROVIDER_SECRET_NAMES = [
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
  "CODEX_API_KEY",
  "OPENCODE_GO_API_KEY",
  "LLM_API_KEY",
]

/**
 * Load all secrets from Bun.secrets exclusively.
 * Returns a warning list of any secrets that could not be found.
 */
export function loadSecrets(): Record<string, string> {
  const secrets: Record<string, string> = {}
  let found = 0
  const missing: string[] = []

  for (const name of listBunSecrets()) {
    const value = readBunSecret(name)
    if (value) {
      secrets[name] = value
      found++
    }
  }

  // Check for expected provider keys
  for (const name of PROVIDER_SECRET_NAMES) {
    if (!secrets[name]) {
      missing.push(name)
    }
  }

  // Also load coordinator config from Bun.secrets
  const coordinatorProvider = readBunSecret("HIVE_COORDINATOR_PROVIDER") || "anthropic"
  const coordinatorModel = readBunSecret("HIVE_COORDINATOR_MODEL") || "claude-sonnet-4-6"
  secrets["HIVE_COORDINATOR_PROVIDER"] = coordinatorProvider
  secrets["HIVE_COORDINATOR_MODEL"] = coordinatorModel

  if (found > 0) {
    console.info(`${logPrefix} ✅ Loaded ${found} key(s) from Bun.secrets (OS keystore)`)
  } else {
    console.warn(`${logPrefix} ⚠️  No secrets found in Bun.secrets. Run: bunx @johpaz/hivecode secret set <name>`)
  }

  if (missing.length > 0 && missing.length < PROVIDER_SECRET_NAMES.length) {
    console.info(`${logPrefix} ℹ️  Missing provider keys in Bun.secrets: ${missing.join(", ")}`)
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