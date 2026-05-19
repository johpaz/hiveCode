/**
 * CORS helper — TDD §38.8
 *
 * Strict allowlist: only https://localhost:${port} and https://127.0.0.1:${port}
 * Requests without Origin (TUI direct) are allowed.
 * Disallowed origins → 403 Forbidden.
 */

import { applySecurityHeaders } from "./security-headers.ts";

/**
 * Build the list of allowed origins for a given port.
 */
export function getAllowedOrigins(port: number): string[] {
  return [
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
  ];
}

/**
 * Check if an origin is allowed.
 * - No origin → allowed (direct API/TUI calls)
 * - Localhost/127.0.0.1 on the gateway port → allowed
 * - Dev mode: Vite dashboard origins → allowed
 * - Anything else → denied
 */
export function isAllowedOrigin(origin: string | null, port: number): boolean {
  if (!origin) return true; // Direct API calls (TUI, curl)
  const allowed = getAllowedOrigins(port);
  if (allowed.includes(origin)) return true;
  // Dev mode: allow Vite dev server origins
  const isDev = process.env.HIVE_DEV === "true" || process.env.HIVE_DEV === "1";
  if (isDev) {
    const devOrigins = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"];
    if (devOrigins.includes(origin)) return true;
  }
  return false;
}

/**
 * Add CORS headers to a response for allowed origins.
 * Also applies security headers if available.
 * Returns 403 if origin is not allowed and port is provided.
 */
export function addCorsHeaders(response: Response, request: Request, port?: number): Response {
  const origin = request.headers.get("Origin");
  if (!origin) {
    // No origin = direct API call (TUI, curl) — apply security headers only
    return applySecurityHeaders(response);
  }

  if (port !== undefined && !isAllowedOrigin(origin, port)) {
    // Origin not allowed — return 403 without CORS headers
    return applySecurityHeaders(new Response("Forbidden: origin not allowed", { status: 403 }));
  }

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Hive-Token, Accept, X-Requested-With");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Max-Age", "86400");

  const withCors = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  return applySecurityHeaders(withCors);
}

/**
 * Build a CORS preflight response for allowed origins.
 * Returns 403 if origin is not allowed.
 */
export function buildCorsPreflight(request: Request, port: number): Response {
  const origin = request.headers.get("Origin");
  if (!origin || isAllowedOrigin(origin, port)) {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Hive-Token, Accept, X-Requested-With",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
    return applySecurityHeaders(new Response(null, { status: 204, headers }));
  }
  return applySecurityHeaders(new Response("Forbidden: origin not allowed", { status: 403 }));
}

// Legacy constant for backward compatibility during migration
export const CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"];
