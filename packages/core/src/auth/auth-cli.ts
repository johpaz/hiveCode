/**
 * CLI browser-based auth flow for `hivecode-free`.
 *
 * Flow:
 *   1. Generate random `state` (CSRF token).
 *   2. Open the user's browser at `${apiBase}/auth/cli?state=XXX`.
 *   3. User logs in with Firebase (Google or email) in the browser.
 *   4. Operator's backend redirects to `http://127.0.0.1:<port>/callback?token=YYY&state=XXX`.
 *   5. We capture the token, validate `state`, store it in Bun.secrets.
 *   6. Print a friendly success message and exit.
 *
 * The user is guided by a terminal panel showing each step.
 *
 * Environment variables:
 *   HIVE_FREE_API_URL   — base URL of the operator's API (default https://api.hivecode.local/v1)
 *   HIVE_FREE_AUTH_PORT — local port for the callback server (default 18923)
 */

import { generatePKCE } from "./auth-pkce"
import { logger } from "@johpaz/hivecode-core/utils/logger"

const log = logger.child("auth-cli")

const CLI_AUTH_SECRET = "hive-cli-auth"          // Bun.secrets name
const DEFAULT_PORT = 18923

export interface AuthSuccess {
  token: string
  email?: string
  expiresAt?: number
}

export interface AuthCliOptions {
  apiBase?: string          // default: env HIVE_FREE_API_URL or https://api.hivecode.local/v1
  callbackPort?: number     // default: env HIVE_FREE_AUTH_PORT or 18923
  openBrowser?: (url: string) => Promise<void>  // injectable for tests
  /** Hostname the callback server binds to. Default 127.0.0.1. */
  callbackHost?: string
}

export async function runAuthCli(opts: AuthCliOptions = {}): Promise<AuthSuccess | null> {
  const apiBase = (opts.apiBase || process.env.HIVE_FREE_API_URL || "https://api.hivecode.local/v1").replace(/\/+$/, "")
  const port = Number(opts.callbackPort || process.env.HIVE_FREE_AUTH_PORT || DEFAULT_PORT)
  const host = opts.callbackHost || "127.0.0.1"
  const openBrowser = opts.openBrowser || defaultOpenBrowser

  const { verifier, challenge } = await generatePKCE()
  const state = cryptoRandom(32)

  // ── 1. Start local callback server ───────────────────────────────────────
  const received = new Promise<{ token?: string; state: string; err?: string }>((resolve) => {
    const server = Bun.serve({
      hostname: host,
      port,
      development: process.env.NODE_ENV !== "production",
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/callback") {
          const token = url.searchParams.get("token") || undefined
          const returnedState = url.searchParams.get("state") || ""
          const err = url.searchParams.get("error") || undefined
          resolve({ token, state: returnedState, err })
          // Render a friendly page in the browser
          return new Response(
            err
              ? `<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px"><h1>❌ Error de auth</h1><p>${err}</p><p>Vuelve a la terminal y reintenta con: <code>hivecode login</code></p></body></html>`
              : `<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px"><h1>✅ Autenticado</h1><p>Puedes cerrar esta ventana y volver a la terminal.</p><script>setTimeout(() => window.close(), 1500)</script></body></html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          )
        }
        if (url.pathname === "/health") return new Response("ok")
        return new Response("not found", { status: 404 })
      },
    })
    log.info(`[auth-cli] callback server listening on http://${host}:${port}`)
  })

  // ── 2. Open browser ──────────────────────────────────────────────────────
  const url = `${apiBase}/auth/cli?state=${state}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=http://${host}:${port}/callback`
  log.info(`[auth-cli] opening ${url}`)
  try {
    await openBrowser(url)
  } catch (err) {
    log.warn(`[auth-cli] openBrowser failed: ${(err as Error).message}`)
  }

  // ── 3. Wait for callback (timeout 5 min) ─────────────────────────────────
  const timeoutMs = 5 * 60 * 1000
  const result = await Promise.race([
    received,
    new Promise<{ err: string }>((resolve) =>
      setTimeout(() => resolve({ err: "timeout" }), timeoutMs)
    ),
  ])

  if (!result || "err" in result) {
    const err = (result as { err?: string })?.err || "unknown"
    log.error(`[auth-cli] auth failed: ${err}`)
    return null
  }

  // ── 4. Validate state (CSRF) ─────────────────────────────────────────────
  if (result.state !== state) {
    log.error(`[auth-cli] state mismatch (possible CSRF) — got "${result.state}", expected "${state}"`)
    return null
  }

  if (!result.token) {
    log.error(`[auth-cli] callback did not include a token`)
    return null
  }

  // ── 5. Decode JWT payload (best-effort, no signature verification) ──────
  const claims = decodeJwtClaims(result.token)
  const success: AuthSuccess = {
    token: result.token,
    email: claims?.email as string | undefined,
    expiresAt: claims?.exp as number | undefined,
  }

  // ── 6. Persist in Bun.secrets ────────────────────────────────────────────
  await Bun.secrets.set({
    service: "hive-code",
    name: `provider.hivecode-free`,
    value: result.token,
  })
  // Also store the PKCE verifier + metadata in case the operator backend
  // wants to re-validate or rotate. Optional.
  await Bun.secrets.set({
    service: "hive-code",
    name: "hive-cli-auth-meta",
    value: JSON.stringify({
      email: success.email,
      expiresAt: success.expiresAt,
      obtainedAt: Math.floor(Date.now() / 1000),
    }),
  })

  log.info(`[auth-cli] ✓ hivecode_token guardado (${success.email || "sin email"})`)
  return success
}

/**
 * Check if a hivecode_token is currently stored.
 */
export async function hasStoredAuth(): Promise<{ hasToken: boolean; email?: string; expiresAt?: number; expired: boolean }> {
  const token = await Bun.secrets
    .get({ service: "hive-code", name: `provider.hivecode-free` })
    .catch(() => null)
  if (!token) return { hasToken: false, expired: false }

  const metaRaw = await Bun.secrets
    .get({ service: "hive-code", name: "hive-cli-auth-meta" })
    .catch(() => null)
  let email: string | undefined
  let expiresAt: number | undefined
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as { email?: string; expiresAt?: number }
      email = meta.email
      expiresAt = meta.expiresAt
    } catch { /* ignore */ }
  }

  const expired = expiresAt ? expiresAt * 1000 < Date.now() : false
  return { hasToken: true, email, expiresAt, expired }
}

/**
 * Remove the stored hivecode_token.
 */
export async function clearAuth(): Promise<void> {
  await Bun.secrets.delete({ service: "hive-code", name: `provider.hivecode-free` })
  await Bun.secrets.delete({ service: "hive-code", name: "hive-cli-auth-meta" })
}

function cryptoRandom(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".")
  if (parts.length !== 3) return null
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

async function defaultOpenBrowser(url: string): Promise<void> {
  // Cross-platform: prefer xdg-open / open, fallback to `start`
  const { spawn } = await import("node:child_process")
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open"
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref()
}
