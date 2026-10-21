import { expect, test } from "bun:test"
import { withExecutionSlot } from "./execution-limits"

const overlap = async (writerA: string, writerB: string) => {
  let running = 0, peak = 0
  const work = async () => { running++; peak = Math.max(peak, running); await Bun.sleep(30); running-- }
  await Promise.all([withExecutionSlot("s", undefined, work, writerA), withExecutionSlot("s", undefined, work, writerB)])
  return peak
}

test("writes to different files overlap", async () => {
  expect(await overlap("/ws/a.ts", "/ws/b.ts")).toBe(2)
})

test("a write to the same file, or one inside a locked workspace, waits", async () => {
  expect(await overlap("/ws/a.ts", "/ws/a.ts")).toBe(1)
  expect(await overlap("/ws", "/ws/a.ts")).toBe(1) // a shell locks the whole workspace
  expect(await overlap("/ws/a.ts", "/ws")).toBe(1)
})

test("sibling workspaces do not exclude each other", async () => {
  expect(await overlap("/ws/builder", "/ws/builder2")).toBe(2)
})
