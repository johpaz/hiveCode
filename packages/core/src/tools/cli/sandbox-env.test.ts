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
