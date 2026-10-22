import { describe, expect, test } from "bun:test"
import { acquireWorkerSlot, workerSlotUsage } from "./worker-slots"

describe("worker slots", () => {
  test("nothing waits: any number of workers start at once, readers included", async () => {
    const releases = await Promise.all(Array.from({ length: 12 }, (_, i) => acquireWorkerSlot("t", { readOnly: i % 2 === 0 })))
    expect(workerSlotUsage("t").active).toBe(12)
    releases.forEach(release => release())
    expect(workerSlotUsage("t").active).toBe(0)
  })

  test("a double release frees one place only", async () => {
    const a = await acquireWorkerSlot("t2")
    const b = await acquireWorkerSlot("t2")
    a(); a()
    expect(workerSlotUsage("t2").active).toBe(1)
    b()
  })

  test("a worker already cancelled does not start, and tasks do not share counts", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(acquireWorkerSlot("t3", { signal: controller.signal })).rejects.toBeDefined()
    const one = await acquireWorkerSlot("one")
    expect(workerSlotUsage("two").active).toBe(0)
    one()
  })
})
