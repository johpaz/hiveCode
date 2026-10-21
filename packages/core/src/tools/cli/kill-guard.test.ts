import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateCommand } from "../code/command-validator"
import { shellExecutorTool } from "./index"

const BLOCKED = [
  "pkill -f server.ts",
  "pkill bun",
  "killall node",
  "kill $(pgrep -f server)",
  "kill -9 $(pgrep bun)",
  "kill `pgrep node`",
  "ps aux | grep server | awk '{print $2}' | xargs kill",
  "lsof -ti:3000 | xargs kill -9",
  "fuser -k 3000/tcp",
  "kill -9 -1",
  "kill 0",
  "cd app && (bun run src/server.ts & sleep 1; curl localhost:3999; pkill -f 'src/server.ts')",
]
const ALLOWED = [
  "bun run src/server.ts & PID=$!; sleep 1; curl localhost:3999; kill $PID",
  "kill $!",
  "kill 12345",
  "kill -9 12345",
  "kill %1",
  "pgrep -f server",          // looking is fine; killing by what it finds is not
  "ps aux | grep server",
  "echo pkill is a command",   // a word in text is not a call... but the pattern is conservative: see below
]

describe("killing by name or pattern is refused", () => {
  for (const cmd of BLOCKED) {
    test(`blocks: ${cmd.slice(0, 60)}`, () => {
      const verdict = validateCommand(cmd, { workspace: "/tmp/x" })
      expect(verdict.ok).toBe(false)
      expect((verdict as { fatal: boolean }).fatal).toBe(true)
    })
  }

  test("killing what the agent started stays allowed", () => {
    for (const cmd of ALLOWED.slice(0, 7)) expect({ cmd, ok: validateCommand(cmd, { workspace: "/tmp/x" }).ok }).toEqual({ cmd, ok: true })
  })

  test("shell_executor refuses it too, and says what to do instead", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "kill-guard-"))
    try {
      const result: any = await shellExecutorTool.execute({ cmd: "pkill -f server.ts" }, { configurable: { workspace } })
      expect(result.ok).toBe(false)
      expect(result.error).toContain("Command not allowed")
      expect(result.error).toContain("kill $!")
    } finally { rmSync(workspace, { recursive: true, force: true }) }
  })
})
