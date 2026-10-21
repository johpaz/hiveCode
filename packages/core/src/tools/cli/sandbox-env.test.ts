import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildSandboxEnv } from "./index"

test("a sandboxed command gets HOME and TMPDIR outside the workspace", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "hivecode-ws-"))
  const env = buildSandboxEnv(workspace)
  for (const dir of [env.HOME!, env.TMPDIR!]) {
    expect(path.relative(workspace, dir).startsWith("..")).toBe(true)
  }
  // Estable por workspace: los cachés se reutilizan entre comandos de la misma tarea.
  expect(buildSandboxEnv(workspace).HOME).toBe(env.HOME)
  expect(buildSandboxEnv(mkdtempSync(path.join(tmpdir(), "hivecode-ws-"))).HOME).not.toBe(env.HOME)
})

test("the sandbox PATH includes the directory of the bun that runs hivecode", () => {
  const bun = Bun.which("bun")
  if (!bun) return
  expect(buildSandboxEnv("/tmp/ws-path").PATH!.split(":")).toContain(require("node:path").dirname(bun))
})

test("redirecting to /dev/null is allowed; writing to a real device is not", async () => {
  const { shellExecutorTool } = await import("./index")
  const ok = await shellExecutorTool.execute!({ cmd: "echo hola 2>/dev/null >/dev/null; echo fin" }, { configurable: { workspace: process.cwd() } }) as any
  expect(ok.error ?? "").not.toContain("device file")
  const bad = await shellExecutorTool.execute!({ cmd: "echo x > /dev/sda" }, { configurable: { workspace: process.cwd() } }) as any
  expect(String(bad.error)).toContain("device file")
})
