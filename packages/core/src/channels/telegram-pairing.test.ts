import { afterAll, beforeEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb"
import { cancelPairing, claimPairing, PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, pairingPending, startPairing } from "./telegram-pairing"
import { TelegramChannel } from "./telegram"

const previous = process.env.HIVE_DB_PATH
beforeEach(() => { closeHiveDb(); process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hive-pair-")), "hivedb") })
afterAll(() => { closeHiveDb(); if (previous === undefined) delete process.env.HIVE_DB_PATH; else process.env.HIVE_DB_PATH = previous })

function chat(policy: "pairing" | "allowlist" | "open", allowFrom: string[] = [], groups = false) {
  const channel = new TelegramChannel("telegram", { botToken: "x", dmPolicy: policy, allowFrom, enabled: true, groups } as any)
  const handled: string[] = []
  channel.onMessage(async message => { handled.push(message.content) })
  ;(channel as any).bot = { api: {} }
  const say = async (userId: number, text: string, opts: { group?: boolean } = {}) => {
    const replies: string[] = []
    const ctx: any = {
      message: { message_id: Math.floor(Math.random() * 1e9), text, chat: { id: opts.group ? -100123 : userId, type: opts.group ? "supergroup" : "private" }, from: { id: userId, is_bot: false } },
      reply: async (body: string) => { replies.push(body) },
    }
    await (channel as any).handleTelegramMessage(ctx)
    return replies
  }
  return { channel, handled, say }
}

test("a code is random, single-use and shown formatted; a wrong one is refused", async () => {
  const { code } = await startPairing()
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  expect(await claimPairing("ZZZZ-ZZZZ")).toBe("invalid")
  expect(await claimPairing(code)).toBe("ok")
  expect(await claimPairing(code)).toBe("none") // spent
})

test("the code expires, and guessing is cut off after a few tries", async () => {
  const first = await startPairing(1_000)
  expect(await claimPairing(first.code, 1_000 + PAIRING_TTL_MS + 1)).toBe("expired")
  const second = await startPairing()
  for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) expect(await claimPairing("AAAA-AAAA")).toBe("invalid")
  expect(await claimPairing(second.code)).toBe("none") // destroyed by the failed guesses, even the right code
  expect(await pairingPending()).toBe(false)
})

test("a new code replaces the old one; cancelling removes it", async () => {
  const old = await startPairing()
  const fresh = await startPairing()
  expect(await claimPairing(old.code)).toBe("invalid")
  expect(await claimPairing(fresh.code)).toBe("ok")
  await startPairing(); await cancelPairing()
  expect(await pairingPending()).toBe(false)
})

test("before pairing nobody is served; the first person with the code becomes the only owner", async () => {
  const { say, handled } = chat("pairing")
  expect((await say(111, "hola")).join()).toContain("No estás autorizado")
  expect(handled).toEqual([])

  const { code } = await startPairing()
  const claim = await say(111, `/start ${code}`)
  expect(claim.join()).toContain("Vinculado")

  await say(111, "haz algo"); expect(handled).toEqual(["haz algo"])           // the owner is served
  expect(await say(222, "haz otra cosa")).toHaveLength(1); expect(handled).toEqual(["haz algo"]) // a stranger is not
  expect((await say(222, `/start ${code}`)).join()).toContain("No hay ninguna vinculación")      // the code is spent
})

test("strangers cannot read or change anything through the commands that used to run unchecked", async () => {
  const { say, handled } = chat("pairing", ["111"])
  for (const command of ["/status", "/tareas", "/narrativo", "/buscar secreto", "/costo", "/modo", "/pausa", "/reanudar", "/cancelar", "/doctor", "/help", "/stop", "/new"]) {
    const replies = await say(999, command)
    for (const reply of replies) {
      expect(reply).not.toMatch(/Provider|Tareas|Narrativo|Modo actual|Doctor|Comandos de hivecode/i)
    }
  }
  expect(handled).toEqual([])
})

test("a stranger is answered once, not on every message", async () => {
  const { say } = chat("pairing", ["111"])
  expect(await say(999, "uno")).toHaveLength(1)
  expect(await say(999, "dos")).toHaveLength(0)
  expect(await say(999, "tres")).toHaveLength(0)
})

test("in a group only listed people are served, and strangers get no reply at all", async () => {
  const { say, handled } = chat("allowlist", ["111"], true)
  expect(await say(222, "hola grupo", { group: true })).toEqual([])
  expect(await say(111, "hola grupo", { group: true })).toEqual([])
  expect(handled).toEqual(["hola grupo"])
})

test("a group member cannot pair in public", async () => {
  const { say } = chat("pairing", [], true)
  const { code } = await startPairing()
  expect((await say(222, `/start ${code}`, { group: true })).join()).toContain("chat privado")
  expect(await pairingPending()).toBe(true)
})

test("policy 'open' still serves everybody (an explicit choice, with a warning at setup)", async () => {
  const { say, handled } = chat("open")
  await say(555, "hola")
  expect(handled).toEqual(["hola"])
})

// ── /stop, /new and the buttons that used to claim more than they did ───────────────────────────

import { beginChannelRun, currentThreadId, registerCoordinatorControl } from "../agent/task-control"

test("/stop aborts the run of that chat and the coordinator's active task, and says what it stopped", async () => {
  const { say } = chat("pairing", ["111"])
  const run = beginChannelRun("telegram:111")
  const cancelled: string[] = []
  registerCoordinatorControl({ hasActiveTask: () => true, cancelActive: async () => { cancelled.push("T1"); return { taskId: "01a15c7c-aaaa" } }, cancelTask: async () => {}, closeSession: () => false })
  try {
    const replies = await say(111, "/stop")
    expect(run.signal.aborted).toBe(true)
    expect(cancelled).toEqual(["T1"])
    expect(replies.join()).toContain("la respuesta en curso")
    expect(replies.join()).toContain("la tarea")
  } finally { registerCoordinatorControl(null) }
})

test("/stop with nothing running says so instead of claiming it stopped something", async () => {
  const { say } = chat("pairing", ["111"])
  expect((await say(111, "/stop")).join()).toContain("No hay nada en curso")
})

test("/new starts a fresh thread without deleting the old one, and refuses while a task runs", async () => {
  const { say } = chat("pairing", ["111"])
  expect(await currentThreadId("user-1", "telegram:111")).toBe("user-1")
  registerCoordinatorControl({ hasActiveTask: () => true, cancelActive: async () => null, cancelTask: async () => {}, closeSession: () => false })
  expect((await say(111, "/new")).join()).toContain("/stop primero")
  expect(await currentThreadId("user-1", "telegram:111")).toBe("user-1")
  registerCoordinatorControl({ hasActiveTask: () => false, cancelActive: async () => null, cancelTask: async () => {}, closeSession: () => true })
  try {
    expect((await say(111, "/new")).join()).toContain("Conversación nueva")
    expect(await currentThreadId("user-1", "telegram:111")).toBe("user-1~1")
    expect(await currentThreadId("other-user", "telegram:222")).toBe("other-user") // nobody else is affected
  } finally { registerCoordinatorControl(null) }
})

test("/pausa and /reanudar no longer pretend", async () => {
  const { say } = chat("pairing", ["111"])
  for (const command of ["/pausa", "/reanudar"]) expect((await say(111, command)).join()).toContain("no se puede pausar")
})

test("fixing a mistyped pairing code by editing the message works", async () => {
  const { channel } = chat("pairing")
  const { code } = await startPairing()
  const replies: string[] = []
  const edited: any = {
    editedMessage: { message_id: 7, text: `/start ${code}`, chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false } },
    reply: async (body: string) => { replies.push(body) },
  }
  // Same message id as the first, wrong attempt that was already answered.
  await (channel as any).handleTelegramMessage({ message: { message_id: 7, text: "/start", chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false } }, reply: async () => {} })
  await (channel as any).handleTelegramMessage(edited)
  expect(replies.join()).toContain("Vinculado")
  expect(channel.config.allowFrom).toContain("111")
})
