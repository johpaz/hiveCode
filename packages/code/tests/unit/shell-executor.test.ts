import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { shellExecutorTool } from "@johpaz/hivecode-core/tools/cli"

describe("shell_executor: naming", () => {
  test("tool name is shell_executor", () => {
    expect(shellExecutorTool.name).toBe("shell_executor")
  })

  test("requires cmd parameter", () => {
    const params = shellExecutorTool.parameters as any
    expect(params.required).toContain("cmd")
  })
})

describe("shell_executor: BLOCKED_PATTERNS", () => {
  const config = {
    configurable: { workspace: os.tmpdir() },
  }

  test("blocks rm -rf /", async () => {
    const result = await shellExecutorTool.execute!({ cmd: "rm -rf /" }, config)
    expect(result).toMatchObject({ ok: false })
    expect((result as any).error).toContain("not allowed")
  })

  test("blocks rm -rf ~", async () => {
    const result = await shellExecutorTool.execute!({ cmd: "rm -rf ~" }, config)
    expect(result).toMatchObject({ ok: false })
  })

  test("blocks dd if=", async () => {
    const result = await shellExecutorTool.execute!({ cmd: "dd if=/dev/zero of=/dev/sda" }, config)
    expect(result).toMatchObject({ ok: false })
  })

  test("blocks fork bomb", async () => {
    const result = await shellExecutorTool.execute!({ cmd: ":() { :|:& };:" }, config)
    expect(result).toMatchObject({ ok: false })
  })

  test("allows safe command", async () => {
    const result = await shellExecutorTool.execute!({ cmd: "echo hello" }, config)
    expect((result as any).ok).toBe(true)
    expect((result as any).stdout).toBe("hello")
  })
})

describe("shell_executor: workspace enforcement", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-shell-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("rejects when no workspace configured", async () => {
    const result = await shellExecutorTool.execute!({ cmd: "echo hello" }, {})
    expect(result).toMatchObject({ ok: false })
    expect((result as any).error).toContain("no workspace configured")
  })

  test("executes in workspace cwd by default", async () => {
    const config = { configurable: { workspace: tmpDir } }
    const result = await shellExecutorTool.execute!({ cmd: "pwd" }, config)
    expect((result as any).ok).toBe(true)
    expect((result as any).stdout).toBe(tmpDir)
  })

  test("rejects cwd outside workspace", async () => {
    const config = { configurable: { workspace: tmpDir } }
    const result = await shellExecutorTool.execute!({ cmd: "pwd", cwd: "/etc" }, config)
    expect(result).toMatchObject({ ok: false })
    expect((result as any).error).toContain("Access denied")
  })
})

describe("shell_executor: env sandbox", () => {
  test("strips dangerous env vars from child process", async () => {
    process.env.HIVE_DANGEROUS_SECRET = "leaked"
    const config = { configurable: { workspace: os.tmpdir() } }
    const result = await shellExecutorTool.execute!({ cmd: "echo $HIVE_DANGEROUS_SECRET" }, config)
    expect((result as any).ok).toBe(true)
    expect((result as any).stdout).not.toContain("leaked")
    delete process.env.HIVE_DANGEROUS_SECRET
  })

  test("keeps PATH in child process", async () => {
    const config = { configurable: { workspace: os.tmpdir() } }
    const result = await shellExecutorTool.execute!({ cmd: "echo $PATH" }, config)
    expect((result as any).ok).toBe(true)
    expect((result as any).stdout.length).toBeGreaterThan(0)
  })
})

describe("shell_executor: timeout", () => {
  test("kills process after timeout", async () => {
    const config = { configurable: { workspace: os.tmpdir() } }
    const result = await shellExecutorTool.execute!({ cmd: "sleep 60", timeout: 1 }, config)
    expect((result as any).exitCode).toBe(-1)
  })
})

describe("shell_executor: backward compat cmd alias", () => {
  test("accepts 'command' as alias for 'cmd'", async () => {
    const config = { configurable: { workspace: os.tmpdir() } }
    const result = await shellExecutorTool.execute!({ command: "echo alias" }, config)
    expect((result as any).ok).toBe(true)
    expect((result as any).stdout).toBe("alias")
  })
})
