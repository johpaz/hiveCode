/**
 * Crypto utilities — stubbed to fix build.
 * TODO: Implement real encryption using AES-256-GCM with HIVE_MASTER_KEY.
 */

export function encryptConfig(plain: string, _iv?: string): { encrypted: string; iv: string } {
  return { encrypted: plain, iv: "stub-iv" }
}

export function decryptConfig(encrypted: string | null | undefined, _iv?: string | null): string {
  return encrypted || ""
}

export function encryptApiKey(apiKey: string): { encrypted: string; iv: string } {
  return { encrypted: apiKey, iv: "stub-iv" }
}

export function decryptApiKey(encrypted: string | null | undefined, _iv?: string | null): string {
  return encrypted || ""
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "***"
  return key.slice(0, 4) + "..." + key.slice(-4)
}
