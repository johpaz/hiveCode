import { expect, test } from "bun:test"
import { ChannelManager } from "./manager"

// Two bots polling one Telegram token make Telegram answer 409 to one of them (the "error" status that
// showed up right after connecting). Replacing a channel has to stop the old one first.
test("creating a channel over a running one stops the old instance first", async () => {
  const manager = new ChannelManager({ channels: {} } as any) as any
  const stopped: string[] = []
  const old = { isRunning: () => true, stop: async () => { stopped.push("old") }, onMessage() {} }
  manager.channels.set("telegram:telegram", old)

  await manager.createChannel("telegram", "telegram", { botToken: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", dmPolicy: "pairing" })

  expect(stopped).toEqual(["old"])
  const current = manager.channels.get("telegram:telegram")
  expect(current).not.toBe(old)
  expect(current.config.dmPolicy).toBe("pairing")
})

test("a channel stored without a policy defaults to pairing, never to open", async () => {
  const manager = new ChannelManager({ channels: {} } as any) as any
  await manager.createChannel("telegram", "telegram", { botToken: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })
  expect(manager.channels.get("telegram:telegram").config.dmPolicy).toBe("pairing")
})

test("a failure stopping the old channel does not prevent the new one", async () => {
  const manager = new ChannelManager({ channels: {} } as any) as any
  manager.channels.set("telegram:telegram", { isRunning: () => true, stop: async () => { throw new Error("boom") }, onMessage() {} })
  await manager.createChannel("telegram", "telegram", { botToken: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", dmPolicy: "pairing" })
  expect(manager.channels.get("telegram:telegram").config.dmPolicy).toBe("pairing")
})
