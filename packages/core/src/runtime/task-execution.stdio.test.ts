import { describe, expect, test } from "bun:test"
import { spawnTaskProcess } from "./task-execution"

describe("spawnTaskProcess stdio", () => {
  test("captura stderr en vez de heredarlo del terminal", async () => {
    const proc = spawnTaskProcess(["sh", "-c", "echo fuera >&2"])
    expect(proc.stderr).not.toBeNull()
    expect((await new Response(proc.stderr as ReadableStream).text()).trim()).toBe("fuera")
    expect(await proc.exited).toBe(0)
  })

  test("respeta un stderr explícito y la forma de objeto", async () => {
    const proc = spawnTaskProcess({ cmd: ["sh", "-c", "echo x >&2; echo y"], stdout: "pipe" } as any)
    expect((await new Response(proc.stdout as ReadableStream).text()).trim()).toBe("y")
    expect(proc.stderr).not.toBeNull()
    await proc.exited
  })
})
