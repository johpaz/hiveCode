import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  detectSandboxProvider,
  isSandboxAvailable,
  buildSandboxCommand,
  shouldExcludeCommand,
  buildFilesystemConfig,
  buildNetworkConfig,
  resolveSandboxPath,
  type SandboxConfig,
} from "@johpaz/hivecode-core/tools/cli/sandbox"
import { isBwrapAvailable, buildBwrapCommand } from "@johpaz/hivecode-core/tools/cli/sandbox-bwrap"
import { isSeatbeltAvailable, buildSeatbeltCommand } from "@johpaz/hivecode-core/tools/cli/sandbox-seatbelt"

// ─── Sandbox Engine Tests ───────────────────────────────────────────────────

describe("sandbox: provider detection", () => {
  test("detects bwrap on Linux", () => {
    if (os.platform() === "linux") {
      const provider = detectSandboxProvider()
      if (isBwrapAvailable()) {
        expect(provider).toBe("bwrap")
      }
    }
  })

  test("detects seatbelt on macOS", () => {
    if (os.platform() === "darwin") {
      const provider = detectSandboxProvider()
      if (isSeatbeltAvailable()) {
        expect(provider).toBe("seatbelt")
      }
    }
  })

  test("isSandboxAvailable returns boolean", () => {
    const available = isSandboxAvailable()
    expect(typeof available).toBe("boolean")
  })
})

describe("sandbox: command exclusion", () => {
  test("excludes docker commands", () => {
    const result = shouldExcludeCommand("docker run hello-world", ["docker"])
    expect(result).toBe(true)
  })

  test("excludes kubectl commands", () => {
    const result = shouldExcludeCommand("kubectl get pods", ["kubectl"])
    expect(result).toBe(true)
  })

  test("allows normal commands", () => {
    const result = shouldExcludeCommand("npm test", ["docker", "kubectl"])
    expect(result).toBe(false)
  })

  test("matches prefix only", () => {
    const result = shouldExcludeCommand("docker-compose up", ["docker"])
    expect(result).toBe(true)
  })
})

describe("sandbox: config builders", () => {
  test("buildFilesystemConfig includes workspace as allowWrite", () => {
    const ws = "/tmp/test-workspace"
    const cfg = buildFilesystemConfig(ws, {
      allowWrite: ["/tmp/extra"],
      denyRead: ["~/.ssh"],
    })
    expect(cfg.allowWrite).toContain(ws)
    expect(cfg.allowWrite).toContain("/tmp/extra")
    expect(cfg.denyRead).toContain("~/.ssh")
  })

  test("buildNetworkConfig defaults to enabled", () => {
    const cfg = buildNetworkConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.allowedDomains).toEqual([])
  })

  test("buildNetworkConfig respects user config", () => {
    const cfg = buildNetworkConfig({
      enabled: false,
      allowedDomains: ["example.com"],
    })
    expect(cfg.enabled).toBe(false)
    expect(cfg.allowedDomains).toEqual(["example.com"])
  })

  test("resolveSandboxPath expands ~", () => {
    const result = resolveSandboxPath("~/test", "/workspace")
    expect(result).toContain(os.homedir())
  })

  test("resolveSandboxPath resolves relative paths", () => {
    const result = resolveSandboxPath("subdir/file.txt", "/workspace")
    expect(result).toBe("/workspace/subdir/file.txt")
  })
})

describe("sandbox: buildSandboxCommand", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-sandbox-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeConfig(): SandboxConfig {
    return {
      enabled: true,
      mode: "permissions",
      workspace: tmpDir,
      filesystem: {
        allowWrite: [],
        denyWrite: [],
        denyRead: [],
        allowRead: [],
      },
      network: {
        enabled: true,
        allowedDomains: [],
      },
      excludedCommands: [],
      failIfUnavailable: false,
    }
  }

  test("returns error when sandbox not enabled", () => {
    const result = buildSandboxCommand("echo hello", { ...makeConfig(), enabled: false })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not enabled")
  })

  test("returns error for excluded commands", () => {
    const result = buildSandboxCommand("docker run test", {
      ...makeConfig(),
      excludedCommands: ["docker"],
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("excluded")
  })

  test("returns sandboxed command on Linux with bwrap", () => {
    if (os.platform() === "linux" && isBwrapAvailable()) {
      const result = buildSandboxCommand("echo hello", makeConfig())
      expect(result.ok).toBe(true)
      expect(result.provider).toBe("bwrap")
      expect(result.command[0]).toContain("bwrap")
      expect(result.command).toContain("echo hello")
    }
  })

  test("returns sandboxed command on macOS with seatbelt", () => {
    if (os.platform() === "darwin" && isSeatbeltAvailable()) {
      const result = buildSandboxCommand("echo hello", makeConfig())
      expect(result.ok).toBe(true)
      expect(result.provider).toBe("seatbelt")
      expect(result.command[0]).toContain("sandbox-exec")
    }
  })

  test("fails when failIfUnavailable and no provider", () => {
    if (!isSandboxAvailable()) {
      const result = buildSandboxCommand("echo hello", {
        ...makeConfig(),
        failIfUnavailable: true,
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain("failIfUnavailable")
    }
  })
})

// ─── Bubblewrap Backend Tests ───────────────────────────────────────────────

describe("sandbox-bwrap: availability", () => {
  test("isBwrapAvailable returns boolean", () => {
    const result = isBwrapAvailable()
    expect(typeof result).toBe("boolean")
  })
})

describe("sandbox-bwrap: command building", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-bwrap-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeConfig(): SandboxConfig {
    return {
      enabled: true,
      mode: "permissions",
      workspace: tmpDir,
      filesystem: {
        allowWrite: [],
        denyWrite: [],
        denyRead: [],
        allowRead: [],
      },
      network: {
        enabled: true,
        allowedDomains: [],
      },
      excludedCommands: [],
      failIfUnavailable: false,
    }
  }

  test("includes namespace isolation flags", () => {
    const cmd = buildBwrapCommand("echo hello", makeConfig())
    expect(cmd).toContain("--unshare-user")
    expect(cmd).toContain("--unshare-pid")
    expect(cmd).toContain("--unshare-ipc")
    expect(cmd).toContain("--die-with-parent")
  })

  test("includes read-only root", () => {
    const cmd = buildBwrapCommand("echo hello", makeConfig())
    expect(cmd).toContain("--ro-bind")
    expect(cmd).toContain("/")
  })

  test("binds workspace as read-write", () => {
    const cmd = buildBwrapCommand("echo hello", makeConfig())
    expect(cmd).toContain("--bind")
    expect(cmd).toContain(tmpDir)
  })

  test("includes --share-net when network enabled", () => {
    const cmd = buildBwrapCommand("echo hello", {
      ...makeConfig(),
      network: { enabled: true, allowedDomains: [] },
    })
    expect(cmd).toContain("--share-net")
  })

  test("excludes --share-net when network disabled", () => {
    const cmd = buildBwrapCommand("echo hello", {
      ...makeConfig(),
      network: { enabled: false, allowedDomains: [] },
    })
    expect(cmd).not.toContain("--share-net")
  })

  test("sets environment variables", () => {
    const cmd = buildBwrapCommand("echo hello", makeConfig())
    expect(cmd).toContain("--setenv")
    expect(cmd).toContain("PATH")
    expect(cmd).toContain("HOME")
    expect(cmd).toContain(tmpDir)
  })

  test("executes command via /bin/sh -c", () => {
    const cmd = buildBwrapCommand("echo hello", makeConfig())
    expect(cmd).toContain("/bin/sh")
    expect(cmd).toContain("-c")
    expect(cmd).toContain("echo hello")
  })

  test("drops all capabilities", () => {
    const cmd = buildBwrapCommand("echo hello", makeConfig())
    expect(cmd).toContain("--cap-drop")
    expect(cmd).toContain("ALL")
  })
})

// ─── Seatbelt Backend Tests ─────────────────────────────────────────────────

describe("sandbox-seatbelt: availability", () => {
  test("isSeatbeltAvailable returns boolean", () => {
    const result = isSeatbeltAvailable()
    expect(typeof result).toBe("boolean")
  })
})

describe("sandbox-seatbelt: command building", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-seatbelt-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeConfig(): SandboxConfig {
    return {
      enabled: true,
      mode: "permissions",
      workspace: tmpDir,
      filesystem: {
        allowWrite: [],
        denyWrite: [],
        denyRead: [],
        allowRead: [],
      },
      network: {
        enabled: true,
        allowedDomains: [],
      },
      excludedCommands: [],
      failIfUnavailable: false,
    }
  }

  test("uses sandbox-exec", () => {
    const cmd = buildSeatbeltCommand("echo hello", makeConfig())
    expect(cmd[0]).toContain("sandbox-exec")
  })

  test("uses -f flag for profile file", () => {
    const cmd = buildSeatbeltCommand("echo hello", makeConfig())
    expect(cmd).toContain("-f")
  })

  test("executes via /bin/sh -c", () => {
    const cmd = buildSeatbeltCommand("echo hello", makeConfig())
    expect(cmd).toContain("/bin/sh")
    expect(cmd).toContain("-c")
    expect(cmd).toContain("echo hello")
  })

  test("profile file is created in tmp", () => {
    const cmd = buildSeatbeltCommand("echo hello", makeConfig())
    const profilePath = cmd[cmd.indexOf("-f") + 1]
    expect(profilePath).toContain(os.tmpdir())
    expect(profilePath).toContain(".sb")
    // Clean up the profile file
    try { fs.unlinkSync(profilePath) } catch {}
  })
})

// ─── Integration Test: Actual Sandbox Execution ─────────────────────────────

describe("sandbox: integration (requires bwrap)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-sandbox-integration-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("sandboxed command can write to workspace", async () => {
    if (os.platform() !== "linux" || !isBwrapAvailable()) {
      return
    }

    const testFile = path.join(tmpDir, "test.txt")
    const config: SandboxConfig = {
      enabled: true,
      mode: "permissions",
      workspace: tmpDir,
      filesystem: {
        allowWrite: [],
        denyWrite: [],
        denyRead: [],
        allowRead: [],
      },
      network: { enabled: true, allowedDomains: [] },
      excludedCommands: [],
      failIfUnavailable: false,
    }

    const sandboxedCmd = buildBwrapCommand(`echo sandboxed > ${testFile}`, config)

    const proc = Bun.spawn(sandboxedCmd, {
      stdout: "pipe",
      stderr: "pipe",
    })

    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    expect(fs.existsSync(testFile)).toBe(true)
    expect(fs.readFileSync(testFile, "utf-8").trim()).toBe("sandboxed")
  })

  test("sandboxed command cannot write outside workspace", async () => {
    if (os.platform() !== "linux" || !isBwrapAvailable()) {
      return
    }

    const outsideFile = path.join(os.tmpdir(), "escape-test.txt")
    // Clean up if exists
    try { fs.unlinkSync(outsideFile) } catch {}

    const config: SandboxConfig = {
      enabled: true,
      mode: "permissions",
      workspace: tmpDir,
      filesystem: {
        allowWrite: [],
        denyWrite: [],
        denyRead: [],
        allowRead: [],
      },
      network: { enabled: true, allowedDomains: [] },
      excludedCommands: [],
      failIfUnavailable: false,
    }

    const sandboxedCmd = buildBwrapCommand(`echo escaped > ${outsideFile}`, config)

    const proc = Bun.spawn(sandboxedCmd, {
      stdout: "pipe",
      stderr: "pipe",
    })

    const exitCode = await proc.exited
    // Should fail because /tmp outside workspace is read-only
    expect(exitCode).not.toBe(0)
    expect(fs.existsSync(outsideFile)).toBe(false)

    // Clean up
    try { fs.unlinkSync(outsideFile) } catch {}
  })
})
