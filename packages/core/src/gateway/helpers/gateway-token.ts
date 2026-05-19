/**
 * Gateway Token Manager — Bun.secrets-based authentication for the local gateway.
 *
 * TDD §38.4: 256-bit entropy, stored in Bun.secrets, validated with timingSafeEqual.
 */

import * as crypto from "node:crypto";

const SERVICE = "hive-code";
const NAME = "gateway-token";

let cachedToken: string | null = null;

/**
 * Generate a new 256-bit gateway token (64 hex chars).
 */
export function generateGatewayToken(): string {
  const bytes = crypto.randomBytes(32);
  return bytes.toString("hex");
}

/**
 * Store the gateway token in Bun.secrets.
 */
export async function storeGatewayToken(token: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: NAME, value: token });
  cachedToken = token;
}

/**
 * Retrieve the gateway token from Bun.secrets.
 * Uses an in-memory cache to avoid repeated OS keychain lookups.
 */
export async function getGatewayToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  try {
    const token = await Bun.secrets.get({ service: SERVICE, name: NAME });
    if (token) cachedToken = token;
    return token;
  } catch {
    return null;
  }
}

/**
 * Ensure a gateway token exists: load from Bun.secrets or generate a new one.
 */
export async function ensureGatewayToken(): Promise<string> {
  const existing = await getGatewayToken();
  if (existing) return existing;
  const token = generateGatewayToken();
  await storeGatewayToken(token);
  return token;
}

/**
 * Rotate the gateway token (generate new, store, invalidate cache).
 */
export async function rotateGatewayToken(): Promise<string> {
  const token = generateGatewayToken();
  await storeGatewayToken(token);
  return token;
}

/**
 * Validate a provided token against the stored gateway token using timing-safe comparison.
 * Returns true only if both tokens are non-empty and match in constant time.
 */
export async function validateGatewayToken(provided: string | null | undefined): Promise<boolean> {
  if (!provided) return false;
  const expected = await getGatewayToken();
  if (!expected) return false;
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Clear the in-memory cache (useful for testing or after rotation).
 */
export function clearGatewayTokenCache(): void {
  cachedToken = null;
}
