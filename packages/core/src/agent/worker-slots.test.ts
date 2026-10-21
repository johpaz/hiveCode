import { afterEach, describe, expect, test } from "bun:test"
import { acquireWorkerSlot, workerSlotUsage } from "./worker-slots"

const KEY = "task-a"
afterEach(() => { delete process.env.HIVECODE_MAX_WORKERS; delete process.env.HIVECODE_MAX_READERS })

describe("worker slots", () => {
  test("runs up to the cap and queues the rest, in order", async () => {
    const releases = await Promise.all([1, 2, 3].map(() => acquireWorkerSlot(KEY)))
    expect(workerSlotUsage(KEY)).toEqual({ active: 3, waiting: 0 })
    const order: number[] = []
    const fourth = acquireWorkerSlot(KEY).then(r => { order.push(4); return r })
    const fifth = acquireWorkerSlot(KEY).then(r => { order.push(5); return r })
    await Promise.resolve()
    expect(workerSlotUsage(KEY)).toEqual({ active: 3, waiting: 2 })
    releases[0]()
    const r4 = await fourth
    expect(order).toEqual([4])
    releases[1]()
    const r5 = await fifth
    expect(order).toEqual([4, 5])
    for (const r of [releases[2], r4, r5]) r()
    expect(workerSlotUsage(KEY)).toEqual({ active: 0, waiting: 0 })
  })

  test("readers are capped below the total, and a writer passes a waiting reader", async () => {
    const r1 = await acquireWorkerSlot(KEY, { readOnly: true })
    const r2 = await acquireWorkerSlot(KEY, { readOnly: true })
    let thirdReader = false
    const reader = acquireWorkerSlot(KEY, { readOnly: true }).then(r => { thirdReader = true; return r })
    const writer = await acquireWorkerSlot(KEY)
    expect(thirdReader).toBe(false)
    expect(workerSlotUsage(KEY)).toEqual({ active: 3, waiting: 1 })
    r1()
    const r3 = await reader
    for (const r of [r2, writer, r3]) r()
  })

  test("a double release frees one place only", async () => {
    const release = await acquireWorkerSlot(KEY)
    release(); release()
    expect(workerSlotUsage(KEY).active).toBe(0)
  })

  test("a cancelled wait leaves the queue and nothing leaks", async () => {
    process.env.HIVECODE_MAX_WORKERS = "1"
    const first = await acquireWorkerSlot(KEY)
    const abort = new AbortController()
    const waiting = acquireWorkerSlot(KEY, { signal: abort.signal })
    abort.abort(new Error("stop"))
    await expect(waiting).rejects.toThrow("stop")
    expect(workerSlotUsage(KEY)).toEqual({ active: 1, waiting: 0 })
    first()
    expect(workerSlotUsage(KEY)).toEqual({ active: 0, waiting: 0 })
  })

  test("tasks do not share places", async () => {
    process.env.HIVECODE_MAX_WORKERS = "1"
    const a = await acquireWorkerSlot("one")
    const b = await acquireWorkerSlot("two")
    expect(workerSlotUsage("one").active).toBe(1)
    a(); b()
  })
})
