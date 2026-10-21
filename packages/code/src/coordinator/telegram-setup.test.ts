import { expect, test } from "bun:test"
import { normalizeAllowFrom, verifyTelegramToken } from "./telegram-setup"

const reply = (status: number, body: unknown) => async () => ({ ok: status < 400, status, json: async () => body })

test("a token Telegram accepts is verified and names the bot", async () => {
  const seen: string[] = []
  const result = await verifyTelegramToken("123456789:ABCdef-ghiJKLmno_pqrSTUvwxYZ01234", async url => { seen.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: "hive_bot" } }) } })
  expect(result).toEqual({ ok: true, username: "hive_bot" })
  expect(seen[0]).toContain("/getMe")
})

test("a token with the wrong shape never reaches the network", async () => {
  let called = false
  const result = await verifyTelegramToken("123456:invalid-token", async () => { called = true; return { ok: true, status: 200, json: async () => ({}) } })
  expect(result.ok).toBe(false)
  expect(called).toBe(false)
})

test("a rejected token, an error and a timeout are all reported, not saved", async () => {
  const bad = await verifyTelegramToken("123456789:ABCdef-ghiJKLmno_pqrSTUvwxYZ01234", reply(401, { ok: false, description: "Unauthorized" }))
  expect(bad.ok).toBe(false)
  const down = await verifyTelegramToken("123456789:ABCdef-ghiJKLmno_pqrSTUvwxYZ01234", async () => { throw new Error("getaddrinfo ENOTFOUND") })
  expect(down).toMatchObject({ ok: false })
  const slow = await verifyTelegramToken("123456789:ABCdef-ghiJKLmno_pqrSTUvwxYZ01234", (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))), 20)
  expect(slow).toMatchObject({ ok: false })
})

test("the whitelist takes numeric ids and rejects @usernames, which the bot cannot match", () => {
  expect(normalizeAllowFrom("123456, tg:789012 ,123456", "allowlist")).toEqual({ ok: true, allowFrom: ["123456", "789012"] })
  expect(normalizeAllowFrom("@usuario1", "allowlist")).toMatchObject({ ok: false })
  expect(normalizeAllowFrom("", "allowlist")).toMatchObject({ ok: false })
  expect(normalizeAllowFrom("", "open")).toEqual({ ok: true, allowFrom: [] })
})
