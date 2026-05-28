/**
 * Crypto utilities — TDD §38.12
 *
 * API key storage now delegates to Bun.secrets (OS keystore).
 * Legacy SQLite columns (api_key_encrypted, api_key_iv) are ignored.
 */

const SERVICE = "hive-code";

export function encryptConfig(plain: any, _iv?: string): { encrypted: string; iv: string } {
  const str = typeof plain === "string" ? plain : JSON.stringify(plain);
  return { encrypted: str, iv: "legacy" };
}

export function decryptConfig(encrypted: string | null | undefined, _iv?: string | null): any {
  if (!encrypted) return {};
  try {
    return JSON.parse(encrypted);
  } catch {
    return {};
  }
}

/** @deprecated Provider API keys must never be serialized into SQLite. */
export function encryptApiKey(_apiKey: string): never {
  throw new Error("encryptApiKey is disabled; use storeProviderApiKey() with Bun.secrets");
}

/** @deprecated Legacy SQLite API key material is intentionally not readable. */
export function decryptApiKey(_encrypted: string | null | undefined, _iv?: string | null): never {
  throw new Error("decryptApiKey is disabled; use getProviderApiKey() with Bun.secrets");
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

// ── Bun.secrets integration ───────────────────────────────────────────────

/**
 * Store a provider API key in Bun.secrets.
 */
export async function storeProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: `provider.${providerId}`, value: apiKey });
}

/**
 * Retrieve a provider API key from Bun.secrets.
 */
export async function getProviderApiKey(providerId: string): Promise<string | null> {
  try {
    return await Bun.secrets.get({ service: SERVICE, name: `provider.${providerId}` });
  } catch {
    return null;
  }
}

/**
 * Check if a provider has an API key stored in Bun.secrets.
 */
export async function hasProviderApiKey(providerId: string): Promise<boolean> {
  const key = await getProviderApiKey(providerId);
  return !!key;
}

/**
 * Rotate (delete + re-set) a provider API key.
 */
export async function rotateProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  await Bun.secrets.delete({ service: SERVICE, name: `provider.${providerId}` });
  await storeProviderApiKey(providerId, apiKey);
}

/**
 * Delete a provider API key from Bun.secrets.
 */
export async function deleteProviderApiKey(providerId: string): Promise<void> {
  await Bun.secrets.delete({ service: SERVICE, name: `provider.${providerId}` });
}
