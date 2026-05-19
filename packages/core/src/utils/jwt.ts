import * as crypto from "node:crypto";

function base64url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, "base64url").toString("utf8");
}

function parseExpiry(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 900;
  const val = parseInt(match[1]!);
  switch (match[2]) {
    case "s": return val;
    case "m": return val * 60;
    case "h": return val * 3600;
    case "d": return val * 86400;
    default: return 900;
  }
}

// In-memory revocation store (replace with Redis in v1.1)
const revokedJTIs = new Set<string>();

export function revokeJTI(jti: string): void {
  revokedJTIs.add(jti);
}

export function isRevoked(jti: string): boolean {
  return revokedJTIs.has(jti);
}

export function revokeAllSessions(): void {
  revokedJTIs.clear();
}

export interface JWTPayload {
  sub: string;
  iat: number;
  exp?: number;
  jti: string;
  [key: string]: unknown;
}

export async function sign(
  payload: object,
  secret: string,
  options?: { expiresIn?: string }
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);

  const jti = crypto.randomUUID();
  const tokenPayload: Record<string, unknown> = { ...payload, iat: now, jti };

  if (options?.expiresIn) {
    tokenPayload.exp = now + parseExpiry(options.expiresIn);
  }

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(tokenPayload));
  const data = `${headerB64}.${payloadB64}`;

  const signature = await crypto.createHmac("sha256", secret).update(data).digest();
  const sigB64 = signature.toString("base64url");

  return `${data}.${sigB64}`;
}

export function verify<T>(token: string, secret: string): (T & JWTPayload) | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;

    const data = `${headerB64}.${payloadB64}`;
    const expectedSig = crypto.createHmac("sha256", secret).update(data).digest();
    const actualSig = Buffer.from(sigB64!, "base64url");

    if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

    const payload = JSON.parse(base64urlDecode(payloadB64!)) as T & JWTPayload;

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.jti && isRevoked(payload.jti)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Check if a token needs refresh (< 5 minutes remaining).
 */
export function needsRefresh(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const payload = JSON.parse(base64urlDecode(parts[1]!)) as JWTPayload;
    if (!payload.exp) return false;
    const remaining = payload.exp - Math.floor(Date.now() / 1000);
    return remaining < 300; // < 5 minutes
  } catch {
    return false;
  }
}
