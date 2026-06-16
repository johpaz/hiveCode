/**
 * PKCE (Proof Key for Code Exchange) — RFC 7636.
 *
 * Generates a high-entropy `verifier` and its SHA-256 `challenge` (base64url).
 * Used by the CLI auth flow so the operator's backend can verify the callback
 * came from the same client that initiated the login.
 */

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let str = ""
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
  // btoa available in Bun
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomVerifier(byteLength = 64): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

async function sha256(input: string): Promise<ArrayBuffer> {
  const data = new TextEncoder().encode(input)
  return crypto.subtle.digest("SHA-256", data)
}

export interface PKCEPair {
  verifier: string
  challenge: string
}

export async function generatePKCE(): Promise<PKCEPair> {
  const verifier = randomVerifier(64)
  const challenge = base64url(await sha256(verifier))
  return { verifier, challenge }
}
