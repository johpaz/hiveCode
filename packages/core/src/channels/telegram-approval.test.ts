import { afterEach, expect, test } from "bun:test"
import { TelegramChannel } from "./telegram"
import { registerChannelApprovalRequester, registerToolApprovalRequester, requestToolApproval, resolveToolApproval, canRequestToolApproval } from "../agent/tool-approval"

afterEach(() => { registerChannelApprovalRequester("telegram", null); registerToolApprovalRequester(null) })

function channelWithFakeBot() {
  const sent: Array<{ chatId: number; text: string; options: any }> = []
  const channel = new TelegramChannel("test", { botToken: "x", dmPolicy: "open", allowFrom: [], enabled: true } as any)
  ;(channel as any).bot = { api: { sendMessage: async (chatId: number, text: string, options: any) => { sent.push({ chatId, text, options }); return { message_id: 77 } } } }
  ;(channel as any).notifyChatId = 4242
  registerChannelApprovalRequester("telegram", request => (channel as any).askToolApproval(request))
  return { channel, sent }
}

test("a run that came from Telegram is asked with Approve / Reject buttons, and the TUI is not bothered", async () => {
  const { sent } = channelWithFakeBot()
  const tuiAsked: string[] = []
  registerToolApprovalRequester(request => tuiAsked.push(request.tool))
  expect(canRequestToolApproval("telegram")).toBe(true)

  const answer = requestToolApproval({ agent: "builder", tool: "shell_executor", summary: "rm <dir>", detail: '{"cmd":"rm -rf <dir> && echo \\"x\\""}', channel: "telegram" })
  await Bun.sleep(5)

  expect(tuiAsked).toEqual([])
  expect(sent).toHaveLength(1)
  expect(sent[0].chatId).toBe(4242)
  expect(sent[0].options.parse_mode).toBe("HTML")
  // The text is escaped: a `<dir>` in the arguments must not be read as a tag.
  expect(sent[0].text).toContain("rm -rf &lt;dir&gt;")
  expect(sent[0].text).not.toContain("<dir>")
  const buttons = sent[0].options.reply_markup.inline_keyboard[0]
  expect(buttons.map((b: any) => b.text)).toEqual(["✅ Aprobar", "❌ Rechazar"])
  for (const button of buttons) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64)

  const [, verdict, id] = buttons[0].callback_data.split(":")
  expect(verdict).toBe("y")
  expect(resolveToolApproval(id, true)).toBe(true)
  expect(await answer).toBe(true)
})

test("rejecting from the button declines the call", async () => {
  const { sent } = channelWithFakeBot()
  const answer = requestToolApproval({ agent: "bee", tool: "Cerrar la tarea", summary: "APROBAR RESULTADO", detail: "evidencia", kind: "gate", title: "APROBAR RESULTADO", channel: "telegram" })
  await Bun.sleep(5)
  expect(sent[0].text).toContain("APROBAR RESULTADO")
  const [, , id] = sent[0].options.reply_markup.inline_keyboard[0][1].callback_data.split(":")
  resolveToolApproval(id, false)
  expect(await answer).toBe(false)
})

test("a run from another channel still goes to the TUI", async () => {
  const { sent } = channelWithFakeBot()
  const tuiAsked: string[] = []
  registerToolApprovalRequester(request => { tuiAsked.push(request.tool); resolveToolApproval(request.request_id, true) })
  expect(await requestToolApproval({ agent: "bee", tool: "fs_write", summary: "", detail: "" })).toBe(true)
  expect(tuiAsked).toEqual(["fs_write"])
  expect(sent).toHaveLength(0)
})

test("with no chat to ask, the request is declined instead of hanging", async () => {
  const { channel } = channelWithFakeBot()
  ;(channel as any).notifyChatId = null
  expect(await requestToolApproval({ agent: "bee", tool: "fs_write", summary: "", detail: "", channel: "telegram" })).toBe(false)
})

test("a message that cannot be delivered declines the request", async () => {
  const { channel } = channelWithFakeBot()
  ;(channel as any).bot = { api: { sendMessage: async () => { throw new Error("network down") } } }
  expect(await requestToolApproval({ agent: "bee", tool: "fs_write", summary: "", detail: "", channel: "telegram" })).toBe(false)
})
