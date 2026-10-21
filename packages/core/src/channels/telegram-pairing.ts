/**
 * Who owns the bot.
 *
 * Telegram bots are public: anyone who knows the @username can message them, and the token proves
 * nothing about the person talking. The only secret the owner has is the screen they are sitting at, so
 * the owner is whoever sends the one-time code shown there. The code is random, single-use, short-lived
 * and limited in attempts; only its hash is stored. Claiming it adds the sender's numeric Telegram id to
 * the allowlist, and from then on only listed ids are served.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { col } from "../storage/hive.ts";
import type { CodeConfigDoc } from "../storage/collections.ts";

const KEY = "telegram_pairing";
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;
/** No 0/O/1/I: the code is read off a screen and typed on a phone. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface PairingRecord { hash: string; expires_at: number; attempts: number }

const hashOf = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");

async function read(): Promise<PairingRecord | null> {
  const row = (await (await col<CodeConfigDoc>("codeConfig")).get(KEY))?.doc.value;
  try { return row ? JSON.parse(row) as PairingRecord : null; } catch { return null; }
}

async function write(record: PairingRecord | null): Promise<void> {
  const config = await col<CodeConfigDoc>("codeConfig");
  const existing = await config.get(KEY);
  if (!record) { if (existing) await config.delete(KEY).catch(() => {}); return; }
  await config.put(KEY, { key: KEY, value: JSON.stringify(record), updated_at: Math.floor(Date.now() / 1000) }, { expectedVersion: existing?.version ?? 0 });
}

/** A new code; any earlier one stops working. Shown once, to the person at the terminal. */
export async function startPairing(now = Date.now()): Promise<{ code: string; expiresAt: number }> {
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const expiresAt = now + PAIRING_TTL_MS;
  await write({ hash: hashOf(code), expires_at: expiresAt, attempts: 0 });
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
}

export type ClaimResult = "ok" | "invalid" | "expired" | "none";

/** Spends the code if it is right. Wrong guesses count; after too many the code is destroyed. */
export async function claimPairing(code: string, now = Date.now()): Promise<ClaimResult> {
  const record = await read();
  if (!record) return "none";
  if (now > record.expires_at) { await write(null); return "expired"; }
  const wanted = Buffer.from(record.hash);
  const given = Buffer.from(hashOf(code.replace(/-/g, "")));
  if (wanted.length === given.length && timingSafeEqual(wanted, given)) { await write(null); return "ok"; }
  record.attempts += 1;
  await write(record.attempts >= PAIRING_MAX_ATTEMPTS ? null : record);
  return "invalid";
}

export async function cancelPairing(): Promise<void> {
  await write(null);
}

export async function pairingPending(now = Date.now()): Promise<boolean> {
  const record = await read();
  return !!record && now <= record.expires_at;
}
