/**
 * Crypto utilities — stubbed to fix build.
 * TODO: Implement real encryption using AES-256-GCM with HIVE_MASTER_KEY.
 */

export function encryptConfig(plain: any, _iv?: string): { encrypted: string; iv: string } {
  const str = typeof plain === 'string' ? plain : JSON.stringify(plain)
  return { encrypted: str, iv: "stub-iv" }
}

export function decryptConfig(encrypted: string | null | undefined, _iv?: string | null): any {
  if (!encrypted) return {}
  try {
    return JSON.parse(encrypted)
  } catch {
    return {}
  }
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
