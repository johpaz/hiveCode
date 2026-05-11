import * as jwt from "../utils/jwt.ts";
import { hashString } from "../utils/crypto.ts";
import { getDb } from "../storage/sqlite.ts";

const JWT_SECRET = process.env.JWT_SECRET || "hive-default-jwt-secret-change-in-production";
const REFRESH_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: "Bearer";
}

interface JwtPayload {
  userId: string;
  type: "access" | "refresh";
}

export async function generateTokens(userId: string): Promise<AuthTokens> {
  const accessToken = await jwt.sign({ userId, type: "access" }, JWT_SECRET, { expiresIn: "15m" });
  const refreshToken = await jwt.sign({ userId, type: "refresh" }, JWT_SECRET, { expiresIn: "7d" });

  const refreshTokenHash = hashString(refreshToken);
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY_SECONDS;

  const db = getDb();
  db.run(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked) 
     VALUES (?, ?, ?, 0)`,
    [userId, refreshTokenHash, expiresAt]
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: 15 * 60,
    tokenType: "Bearer",
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<AuthTokens> {
  const payload = jwt.verify<JwtPayload>(refreshToken, JWT_SECRET);
  if (!payload || payload.type !== "refresh") {
    throw new Error("Invalid or expired refresh token");
  }

  const refreshTokenHash = hashString(refreshToken);
  const db = getDb();
  const tokenRow = db
    .query(
      `SELECT user_id, expires_at, revoked FROM refresh_tokens WHERE token_hash = ?`
    )
    .get(refreshTokenHash) as { user_id: string; expires_at: number; revoked: number } | undefined;

  if (!tokenRow) throw new Error("Refresh token not found");
  if (tokenRow.revoked === 1) throw new Error("Refresh token has been revoked");

  if (tokenRow.expires_at < Math.floor(Date.now() / 1000)) {
    db.run(`DELETE FROM refresh_tokens WHERE token_hash = ?`, [refreshTokenHash]);
    throw new Error("Refresh token has expired");
  }

  db.run(`DELETE FROM refresh_tokens WHERE token_hash = ?`, [refreshTokenHash]);
  return generateTokens(payload.userId);
}

export async function validateAccessToken(token: string): Promise<{ userId: string } | null> {
  const payload = jwt.verify<JwtPayload>(token, JWT_SECRET);
  if (!payload || payload.type !== "access") return null;
  return { userId: payload.userId };
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const refreshTokenHash = hashString(refreshToken);
  getDb().run(`UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?`, [refreshTokenHash]);
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  getDb().run(`UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`, [userId]);
}
