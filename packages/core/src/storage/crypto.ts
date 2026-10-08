import { createConfigCipher } from "./config-cipher";
/**
 * Crypto utilities — TDD §38.12
 *
 * API keys and the authenticated configuration encryption key use Bun.secrets.
 * Only authenticated encrypted configuration envelopes are accepted.
 */

const SERVICE = "hive-code";

const configCipher = createConfigCipher({
  get: options => Bun.secrets.get(options),
  set: options => Bun.secrets.set(options),
});

export const encryptConfig = configCipher.encrypt;
export const decryptConfig = configCipher.decrypt;

/** Serialize an encrypted envelope for channel documents. */
export async function serializeConfig(config: unknown): Promise<string> {
  return JSON.stringify(await encryptConfig(config));
}

/** Read authenticated envelopes without masking crypto failures. */
export async function deserializeConfig(serialized: string): Promise<Record<string, any>> {
  const value = JSON.parse(serialized);
  if (value && typeof value.encrypted === "string" && typeof value.iv === "string") {
    return await decryptConfig(value.encrypted, value.iv);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored configuration");
  throw new Error("Unsupported stored configuration; run dev reset-records for legacy records");
}

/** @deprecated Provider API keys must never be serialized into document storage. */
export function encryptApiKey(_apiKey: string): never {
  throw new Error("encryptApiKey is disabled; use storeProviderApiKey() with Bun.secrets");
}

/** @deprecated Legacy serialized API key material is intentionally not readable. */
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
    throw new Error(`Provider credential keystore is unavailable: ${providerId}`);
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

// ── hivecode-free (user-token-based, server proxies NVIDIA) ────────────────

/**
 * Check whether a provider is configured as free tier.
 *
 * In this architecture, "free tier" means the client uses a personal
 * `hivecode_token` (issued by the operator's backend after Firebase Auth)
 * stored in Bun.secrets — NOT a server-side env var key. The actual NVIDIA
 * API key lives in the operator's backend, which is what the client talks to.
 */
export function isFreeProvider(providerId: string): boolean {
  return providerId === "hivecode-free" || providerId.endsWith("-free")
}
