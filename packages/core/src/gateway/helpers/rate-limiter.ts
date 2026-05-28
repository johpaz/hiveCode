/**
 * Rate Limiter — TDD §38.9
 *
 * In-memory per-IP+endpoint rate limiting with configurable limits.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 100 };

const ENDPOINT_LIMITS: Record<string, RateLimitConfig> = {
  "POST:/api/auth/login": { windowMs: 60_000, maxRequests: 5 },
  "POST:/api/auth/register": { windowMs: 60_000, maxRequests: 3 },
  "POST:/api/tasks": { windowMs: 60_000, maxRequests: 30 },
  "GET:/api/narrative": { windowMs: 60_000, maxRequests: 60 },
  "WS:/ws": { windowMs: 10_000, maxRequests: 5 },
};

const store = new Map<string, RateLimitEntry>();

function getClientIP(req: Request): string {
  // Trust X-Forwarded-For only if the direct connection is localhost
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "127.0.0.1";
}

function getKey(ip: string, method: string, pathname: string): string {
  const endpointKey = `${method}:${pathname}`;
  // Check exact endpoint match first, then wildcard
  if (ENDPOINT_LIMITS[endpointKey]) {
    return `${ip}:${endpointKey}`;
  }
  return `${ip}:*`;
}

function getConfig(method: string, pathname: string): RateLimitConfig {
  const endpointKey = `${method}:${pathname}`;
  return ENDPOINT_LIMITS[endpointKey] ?? DEFAULT_LIMIT;
}

/**
 * Check if a request should be rate-limited.
 * Returns { allowed: true } if under limit, or { allowed: false, retryAfter } if exceeded.
 */
export function checkRateLimit(req: Request): { allowed: boolean; retryAfter: number } {
  const ip = getClientIP(req);
  const method = req.method;
  const pathname = new URL(req.url).pathname;
  const key = getKey(ip, method, pathname);
  const config = getConfig(method, pathname);
  const now = Date.now();

  const entry = store.get(key);
  if (!entry || now >= entry.resetAt) {
    // First request or window expired
    store.set(key, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  if (entry.count >= config.maxRequests) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  entry.count++;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Clean up expired entries periodically (called manually or by a timer).
 */
export function cleanupRateLimitStore(): void {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now >= entry.resetAt) {
      store.delete(key);
    }
  }
}

// Auto-cleanup every 60 seconds
const cleanupTimer = setInterval(cleanupRateLimitStore, 60_000);
cleanupTimer.unref();
