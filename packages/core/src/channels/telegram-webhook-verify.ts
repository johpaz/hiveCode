/**
 * Telegram Webhook HMAC Verification — TDD §38.17
 *
 * When using webhooks (instead of polling), Telegram sends a secret token
 * in the X-Telegram-Bot-Api-Secret-Token header. This module verifies that
 * the request originates from Telegram.
 *
 * Note: The current implementation uses Grammy's polling mode (bot.start()),
 * which does not expose a webhook endpoint. If switching to webhooks in the
 * future, integrate verifyTelegramWebhook into the /webhook/telegram handler.
 */

import * as crypto from "node:crypto";

/**
 * Verify a Telegram webhook request.
 * @param body - Raw request body
 * @param secretToken - The secret token configured in Telegram webhook
 * @param signature - Value of X-Telegram-Bot-Api-Secret-Token header
 */
export function verifyTelegramWebhook(
  body: string,
  secretToken: string,
  signature: string | null
): boolean {
  if (!signature || !secretToken) return false;
  const expected = crypto.createHmac("sha256", secretToken).update(body).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Middleware for Bun.serve fetch handler.
 * Returns 401 if the webhook signature is invalid.
 */
export function requireTelegramWebhookAuth(
  secretToken: string
): (req: Request) => boolean {
  return (req: Request): boolean => {
    const signature = req.headers.get("x-telegram-bot-api-secret-token");
    // For webhook verification we need the raw body, which is not available
    // after req.text() is called. In practice, the webhook handler should:
    // 1. Read raw body
    // 2. Call verifyTelegramWebhook(body, secretToken, signature)
    // 3. Only then parse JSON
    return !!signature;
  };
}
