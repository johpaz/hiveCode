/**
 * Auth Routes — TDD §38.2, §38.3
 *
 * Provides local authentication endpoints.
 * Password hashing uses Bun.password (bcrypt) with automatic
 * migration from legacy SHA-256 hashes.
 * Firebase Auth integration is optional and configured via environment.
 */

import { sign, verify, revokeJTI, revokeAllSessions, needsRefresh } from "../../utils/jwt";
import { getDb } from "../../storage/sqlite";
import { logger } from "../../utils/logger";

const log = logger.child("auth");

const JWT_SECRET = process.env.HIVE_JWT_SECRET || "hive-code-local-secret-change-me";
const JWT_EXPIRES_IN = "24h";

/**
 * Detect if a hash is a legacy SHA-256 hash (64 hex chars, no bcrypt prefix).
 * Bcrypt hashes always start with $2b$ or $2a$.
 */
function isLegacyHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/i.test(hash)
}

/**
 * Migrate a legacy SHA-256 hash to bcrypt on successful login.
 */
async function migratePasswordHash(userId: string, plainPassword: string): Promise<void> {
  try {
    const newHash = await Bun.password.hash(plainPassword)
    const db = getDb()
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, userId)
    log.info(`Migrated password hash for user ${userId} from SHA-256 to bcrypt`)
  } catch (err) {
    log.warn(`Failed to migrate password hash for user ${userId}: ${(err as Error).message}`)
  }
}

interface LoginBody {
  email?: string;
  password?: string;
}

export async function handleAuthLogin(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({})) as LoginBody;

  if (!body.email || !body.password) {
    return addCorsHeaders(Response.json({ error: "Missing email or password" }, { status: 400 }), req);
  }

  const db = getDb();
  const user = db.query<{ id: string; email: string; password_hash: string }, [string]>(
    "SELECT id, email, password_hash FROM users WHERE email = ?"
  ).get(body.email);

  if (!user || !user.password_hash) {
    return addCorsHeaders(Response.json({ error: "Invalid credentials" }, { status: 401 }), req);
  }

  let valid = false

  if (isLegacyHash(user.password_hash)) {
    // Legacy SHA-256 verification
    const { createHash } = await import("node:crypto")
    const sha256Hash = createHash("sha256").update(body.password).digest("hex")
    valid = sha256Hash === user.password_hash
  } else {
    // Modern bcrypt verification
    valid = await Bun.password.verify(body.password, user.password_hash)
  }

  if (!valid) {
    return addCorsHeaders(Response.json({ error: "Invalid credentials" }, { status: 401 }), req);
  }

  // Auto-migrate legacy SHA-256 hashes to bcrypt on successful login
  if (isLegacyHash(user.password_hash)) {
    await migratePasswordHash(user.id, body.password)
  }

  const token = await sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  return addCorsHeaders(Response.json({ token, user: { id: user.id, email: user.email } }), req);
}

export async function handleAuthRegister(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({})) as LoginBody;

  if (!body.email || !body.password) {
    return addCorsHeaders(Response.json({ error: "Missing email or password" }, { status: 400 }), req);
  }

  const db = getDb();
  const existing = db.query<{ count: number }, [string]>("SELECT COUNT(*) as count FROM users WHERE email = ?").get(body.email);

  if (existing && existing.count > 0) {
    return addCorsHeaders(Response.json({ error: "Email already registered" }, { status: 409 }), req);
  }

  const passwordHash = await Bun.password.hash(body.password)
  const id = crypto.randomUUID();

  db.query("INSERT INTO users (id, name, email, password_hash, language, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, body.email.split("@")[0], body.email, passwordHash, "es", "UTC", new Date().toISOString());

  const token = await sign({ sub: id, email: body.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  return addCorsHeaders(Response.json({ token, user: { id, email: body.email } }), req);
}

export async function handleAuthRefresh(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { token?: string };

  if (!body.token) {
    return addCorsHeaders(Response.json({ error: "Missing token" }, { status: 400 }), req);
  }

  const payload = verify(body.token, JWT_SECRET);
  if (!payload) {
    return addCorsHeaders(Response.json({ error: "Invalid token" }, { status: 401 }), req);
  }

  if (!needsRefresh(body.token)) {
    return addCorsHeaders(Response.json({ token: body.token }), req);
  }

  const newToken = await sign({ sub: payload.sub, email: payload.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  return addCorsHeaders(Response.json({ token: newToken }), req);
}

export async function handleAuthLogout(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { token?: string };

  if (body.token) {
    const payload = verify(body.token, JWT_SECRET);
    if (payload?.jti) {
      revokeJTI(payload.jti);
      log.info(`JWT revoked: ${payload.jti}`);
    }
  }

  return addCorsHeaders(Response.json({ success: true }), req);
}

export async function handleAuthStatus(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");

  if (!token) {
    return addCorsHeaders(Response.json({ authenticated: false }), req);
  }

  const payload = verify(token, JWT_SECRET);
  return addCorsHeaders(Response.json({
    authenticated: !!payload,
    user: payload ? { id: payload.sub, email: payload.email } : null,
  }), req);
}

export async function handleAuthRevokeAll(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  revokeAllSessions();
  log.info("All sessions revoked");
  return addCorsHeaders(Response.json({ success: true }), req);
}