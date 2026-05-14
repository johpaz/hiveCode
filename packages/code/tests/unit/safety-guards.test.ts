import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { resolveInWorkspace, expandPath } from "@johpaz/hivecode-core/tools/filesystem/workspace-guard"
import { checkAutomaticInterruption } from "../../src/modes/interruptions"
import type { WorkerToManagerMessage } from "../../src/workers/types"

function makeToolCall(toolName: string, toolArgs: Record<string, unknown>, coordinator = "backend"): WorkerToManagerMessage {
  return {
    type: "TOOL_CALL",
    taskId: "test-task",
    phaseId: 1,
    coordinator,
    toolName,
    toolArgs,
    toolCallId: "tc-1",
  }
}

describe("workspace-guard: resolveInWorkspace", () => {
  test("rejects when workspace is null", () => {
    expect(() => resolveInWorkspace("/etc/passwd", null)).toThrow(/no workspace configured/)
  })

  test("rejects when workspace is undefined", () => {
    expect(() => resolveInWorkspace("/tmp/evil", undefined)).toThrow(/no workspace configured/)
  })

  test("rejects when workspace is empty string", () => {
    expect(() => resolveInWorkspace("/tmp/evil", "")).toThrow(/no workspace configured/)
  })

  test("allows relative path inside workspace", () => {
    const ws = "/tmp/hive-test-ws"
    const result = resolveInWorkspace("src/file.ts", ws)
    expect(result).toBe(path.resolve(ws, "src/file.ts"))
  })

  test("allows absolute path inside workspace", () => {
    const ws = "/tmp/hive-test-ws"
    const result = resolveInWorkspace("/tmp/hive-test-ws/src/file.ts", ws)
    expect(result).toBe("/tmp/hive-test-ws/src/file.ts")
  })

  test("rejects path traversal above workspace", () => {
    const ws = "/tmp/hive-test-ws"
    expect(() => resolveInWorkspace("../../etc/passwd", ws)).toThrow(/Access denied/)
  })

  test("rejects absolute path outside workspace", () => {
    const ws = "/tmp/hive-test-ws"
    expect(() => resolveInWorkspace("/etc/passwd", ws)).toThrow(/Access denied/)
  })
})

describe("workspace-guard: symlink escape protection", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-symlink-"))
    fs.mkdirSync(path.join(tmpDir, "workspace"))
    fs.mkdirSync(path.join(tmpDir, "outside"))
    fs.writeFileSync(path.join(tmpDir, "outside", "secret.txt"), "secret")
    fs.symlinkSync(path.join(tmpDir, "outside"), path.join(tmpDir, "workspace", "escape"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("rejects symlink pointing outside workspace", () => {
    const ws = path.join(tmpDir, "workspace")
    const symlinkPath = path.join(ws, "escape", "secret.txt")
    expect(() => resolveInWorkspace(symlinkPath, ws)).toThrow(/Access denied/)
  })

  test("allows symlink pointing inside workspace", () => {
    const ws = path.join(tmpDir, "workspace")
    fs.writeFileSync(path.join(ws, "real.txt"), "hello")
    fs.symlinkSync(path.join(ws, "real.txt"), path.join(ws, "link.txt"))
    const result = resolveInWorkspace(path.join(ws, "link.txt"), ws)
    expect(result).toBe(path.join(ws, "link.txt"))
  })
})

describe("workspace-guard: expandPath", () => {
  test("expands ~ to home directory", () => {
    const result = expandPath("~/code")
    expect(result).toBe(path.join(os.homedir(), "code"))
  })

  test("passes through non-tilde paths unchanged", () => {
    expect(expandPath("/tmp/file")).toBe("/tmp/file")
  })

  test("passes through relative paths unchanged", () => {
    expect(expandPath("src/index.ts")).toBe("src/index.ts")
  })
})

describe("interruptions: fs_delete against DANGEROUS_FILE_PATTERNS", () => {
  test("blocks fs_delete on .env file", () => {
    const msg = makeToolCall("fs_delete", { path: "/workspace/.env", confirmed: true })
    const result = checkAutomaticInterruption(msg)
    expect(result).not.toBeNull()
    expect(result!.blocked).toBe(true)
    expect(result!.severity).toBe("CRITICAL")
    expect(result!.reason).toContain("eletion")
  })

  test("blocks fs_delete on Bun.secrets file", () => {
    const msg = makeToolCall("fs_delete", { path: "/workspace/Bun.secrets", confirmed: true })
    const result = checkAutomaticInterruption(msg)
    expect(result).not.toBeNull()
    expect(result!.blocked).toBe(true)
  })

  test("blocks fs_delete on config.production file", () => {
    const msg = makeToolCall("fs_delete", { path: "/workspace/config.production.js", confirmed: true })
    const result = checkAutomaticInterruption(msg)
    expect(result).not.toBeNull()
    expect(result!.blocked).toBe(true)
  })

  test("allows fs_delete on normal file", () => {
    const msg = makeToolCall("fs_delete", { path: "/workspace/src/old.ts", confirmed: true })
    const result = checkAutomaticInterruption(msg)
    expect(result).toBeNull()
  })

  test("blocks fs_write on .env file", () => {
    const msg = makeToolCall("fs_write", { path: "/workspace/.env", content: "KEY=VAL" })
    const result = checkAutomaticInterruption(msg)
    expect(result).not.toBeNull()
    expect(result!.blocked).toBe(true)
    expect(result!.severity).toBe("HIGH")
  })

  test("blocks fs_edit on .env file", () => {
    const msg = makeToolCall("fs_edit", { path: "/workspace/.env", oldString: "a", newString: "b" })
    const result = checkAutomaticInterruption(msg)
    expect(result).not.toBeNull()
    expect(result!.blocked).toBe(true)
  })
})

describe("interruptions: existing patterns still work", () => {
  test("blocks dangerous SQL via shell_executor", () => {
    const msg = makeToolCall("shell_executor", { cmd: "psql -c 'DROP TABLE users'" })
    const result = checkAutomaticInterruption(msg)
    expect(result).not.toBeNull()
    expect(result!.severity).toBe("CRITICAL")
  })

  test("blocks push to main via shell_executor", () => {
    const msg = makeToolCall("shell_executor", { cmd: "git push origin main" })
    const result = checkAutomaticInterruption(msg)
    expect(result).not.toBeNull()
    expect(result!.severity).toBe("HIGH")
  })

  test("blocks bun add via shell_executor", () => {
    const msg = makeToolCall("shell_executor", { cmd: "bun add express" })
    const result = checkAutomaticInterruption(msg)
    expect(result).not.toBeNull()
  })

  test("allows safe shell commands", () => {
    const msg = makeToolCall("shell_executor", { cmd: "ls -la" })
    const result = checkAutomaticInterruption(msg)
    expect(result).toBeNull()
  })

  test("returns null for RESULT messages", () => {
    const msg: WorkerToManagerMessage = {
      type: "RESULT",
      taskId: "test",
      phaseId: 1,
      coordinator: "backend",
    }
    expect(checkAutomaticInterruption(msg)).toBeNull()
  })

  test("CRITICAL security finding blocks task", () => {
    const msg = makeToolCall("fs_write", { path: "/workspace/src/a.ts", content: "ok" }, "security")
    msg.toolArgs = { path: "/workspace/src/a.ts", content: "CRITICAL vulnerability found" }
    const result = checkAutomaticInterruption(msg)
    expect(result).not.toBeNull()
    expect(result!.severity).toBe("CRITICAL")
  })
})
