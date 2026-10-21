import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shellExecutorTool } from "./index"

const workspace = mkdtempSync(join(tmpdir(), "shell-bg-"))
const config = { configurable: { workspace } }
const run = (params: Record<string, unknown>) => shellExecutorTool.execute(params, config) as Promise<any>

// A distinctive duration, so a leftover `sleep` can be told from anything else on the machine.
const stray = (marker: number) => Bun.spawnSync(["pgrep", "-f", `^sleep ${marker}$`]).stdout.toString().trim()
const killStray = (marker: number) => { for (const pid of stray(marker).split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL") } catch { /* gone */ } } }

afterAll(() => { rmSync(workspace, { recursive: true, force: true }); killStray(7001); killStray(7002) })

describe("shell_executor and background processes", () => {
  test("returns when the shell exits, even if a process it started still holds the output open", async () => {
    const t0 = Date.now()
    const result = await run({ cmd: "sleep 7001 & echo started", timeout: 30 })
    expect(Date.now() - t0).toBeLessThan(5000) // it used to wait for the 30 s timeout — or forever
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe("started")
    killStray(7001)
  }, 15000)

  test("a timeout stops everything the command started, not only the shell", async () => {
    const t0 = Date.now()
    const result = await run({ cmd: "sleep 7002 & sleep 60", timeout: 1 })
    expect(Date.now() - t0).toBeLessThan(6000)
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain("timeout")
    await Bun.sleep(200)
    expect(stray(7002)).toBe("") // the background sleep died with the group
  }, 15000)

  test("an ordinary command is untouched: stdout, stderr and exit code", async () => {
    const result = await run({ cmd: "echo out; echo err >&2; exit 3" })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe("out")
    expect(result.stderr).toBe("err")
  })

  test("a lot of stderr while stdout is open does not stall the read", async () => {
    const result = await run({ cmd: "head -c 300000 /dev/zero | tr '\\0' x >&2; echo done" })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe("done")
    expect(result.stderr.length).toBeGreaterThan(200000)
  })

  test("output over the limit kills the command instead of buffering it", async () => {
    const result = await run({ cmd: "yes", timeout: 30 })
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain("exceeded")
  }, 40000)
})
