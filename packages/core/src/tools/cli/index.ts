import { spawnTaskProcess } from "../../runtime/task-execution";
/**
 * shell_executor - Execute shell commands in agent workspace
 *
 * @category cli
 * @seedId shell_executor
 * @spanish ejecutar comando, terminal, bash, script, consola
 */

import type { Tool } from "../types.ts";
import { logger } from "../../utils/logger.ts";
import { resolveInWorkspace, getWorkspace, expandPath } from "../filesystem/workspace-guard.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  buildSandboxCommand,
  isSandboxAvailable,
  buildFilesystemConfig,
  buildNetworkConfig,
  type SandboxConfig,
  type SandboxResult,
} from "./sandbox.ts";

const log = logger.child("shell-executor");

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-rf\s+\/[^\s]*/, reason: "recursive delete from root" },
  { pattern: /rm\s+-rf\s+~/, reason: "recursive delete from home" },
  // /dev/null and the standard streams are how scripts discard or redirect output; any other device is not.
  { pattern: />\s*\/dev\/(?!null\b|stdout\b|stderr\b|stdin\b|tty\b|fd\/)/, reason: "write to device file" },
  { pattern: /mkfs/, reason: "filesystem format" },
  { pattern: /dd\s+if=/, reason: "raw disk write" },
  { pattern: /:\(\)\s*\{/, reason: "fork bomb pattern" },
  { pattern: /del\s+\/f\s+\/s/, reason: "recursive force delete (Windows)" },
  { pattern: /format\s+[a-z]:/i, reason: "disk format (Windows)" },
  { pattern: /curl\s+.*\|\s*(sudo\s+)?bash/, reason: "pipe internet script to shell" },
  { pattern: /curl\s+.*\|\s*(sudo\s+)?sh/, reason: "pipe internet script to shell" },
  { pattern: /wget\s+.*-O\s*-\s*\|/, reason: "pipe internet script to shell" },
  { pattern: /python\s+-c\s+.*\bexec\b/, reason: "python exec of arbitrary code" },
  { pattern: /node\s+-e\s+.*\brequire\b/, reason: "node require of arbitrary module" },
  { pattern: /\beval\s*\(/, reason: "eval of arbitrary code" },
  { pattern: /\bnew\s+Function\s*\(/, reason: "new Function of arbitrary code" },
  { pattern: /\bsudo\b/, reason: "privilege escalation (sudo)" },
  { pattern: /\bsu\s+-/, reason: "privilege escalation (su -)" },
  { pattern: /chmod\s+.*7/, reason: "world-writable permissions" },
  { pattern: /chown\s+root/, reason: "change ownership to root" },
  { pattern: /\/etc\/passwd|shadow|sudoers/, reason: "access to system credential files" },
  { pattern: /\/proc\//, reason: "access to /proc filesystem" },
  { pattern: /\/sys\/kernel/, reason: "access to /sys/kernel" },
  { pattern: /Bun\.secrets/, reason: "access to Bun.secrets keystore" },
  { pattern: /process\.env\.[A-Z_]*(?:KEY|SECRET|TOKEN)/, reason: "access to environment secrets" },
  { pattern: /curl\s+.*\$\(cat\s+/, reason: "exfiltration via curl $(cat ...)" },
  { pattern: /base64\s+.*\|\s*curl/, reason: "exfiltration via base64 | curl" },
];

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * HOME and TMPDIR of a sandboxed command live OUTSIDE the workspace: bun, npm and
 * node drop their caches (.bun, .npm, node-compile-cache) under $HOME, and when
 * that was the workspace they were integrated into the user's project.
 */
export function buildSandboxEnv(workspace: string): Record<string, string | undefined> {
  const isolatedTaskDir = path.join(
    os.tmpdir(),
    "hivecode-home",
    workspace ? createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 16) : `sandbox-${Date.now()}`,
  );
  fs.mkdirSync(isolatedTaskDir, { recursive: true });
  // The commands a worker runs (`bun test`, `bunx tsc`) must find the same bun that runs hivecode; it often
  // lives under ~/.bun/bin, outside the minimal PATH. Without it workers install their own copy from npm.
  const bun = Bun.which("bun");
  const toolchain = bun ? [path.dirname(bun)] : [];
  return {
    PATH: [...new Set([...toolchain, "/usr/local/bin", "/usr/bin", "/bin"])].join(":"),
    HOME: isolatedTaskDir,
    TMPDIR: isolatedTaskDir,
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    SHELL: "/bin/sh",
    NODE_ENV: "production",
  };
}

function isInsideWorkspace(cwd: string, workspace: string): boolean {
  const resolved = path.resolve(cwd);
  const wsResolved = path.resolve(expandPath(workspace));
  const relative = path.relative(wsResolved, resolved);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Extract sandbox config from the tool config.
 * Falls back to defaults if not configured.
 */
function resolveSandboxConfig(config: any, workspace: string): SandboxConfig {
  const sandboxCfg = config?.configurable?.sandbox ?? config?.sandbox ?? {}

  return {
    enabled: sandboxCfg.enabled ?? false,
    mode: sandboxCfg.mode ?? "permissions",
    workspace,
    filesystem: buildFilesystemConfig(workspace, sandboxCfg.filesystem),
    network: buildNetworkConfig(sandboxCfg.network),
    excludedCommands: sandboxCfg.excludedCommands ?? [],
    failIfUnavailable: sandboxCfg.failIfUnavailable ?? false,
  }
}

/** How long to wait for the last of a command's output once its shell has exited. */
const OUTPUT_DRAIN_MS = 500;

/**
 * Collects one output stream up to `MAX_OUTPUT_BYTES`, without waiting for it to close: a background
 * process that inherited the pipe keeps it open long after the command is done. `finished` settles
 * when the stream ends or the limit is hit; `stop` gives up on whatever is still pending.
 */
function collectOutput(stream: unknown, onExceeded: () => void) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let exceeded = false;
  const reader = stream && typeof stream === "object" && "getReader" in stream
    ? (stream as ReadableStream<Uint8Array>).getReader()
    : undefined;
  const finished = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          exceeded = true;
          onExceeded();
          break;
        }
        chunks.push(value);
      }
    } catch { /* the pipe was closed under us */ }
  })();
  return {
    finished,
    get exceeded() { return exceeded; },
    text: () => new TextDecoder().decode(Buffer.concat(chunks)),
    stop: () => { void reader?.cancel().catch(() => undefined); },
  };
}

export const shellExecutorTool: Tool = {
  name: "shell_executor",
  description: "Execute shell/bash commands in the agent workspace. The call returns when the shell exits: a command that starts a background process should redirect its output (`cmd > /tmp/out.log 2>&1 &`). NOTE: do NOT use for scheduling tasks, use cron.create instead. Spanish: ejecutar comando, terminal, bash, script, consola",
  parameters: {
    type: "object",
    properties: {
      cmd: {
        type: "string",
        description: "The shell command to execute (supports pipes, redirections, variables)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 30, max: 300)",
      },
      cwd: {
        type: "string",
        description: "Working directory (default: agent workspace)",
      },
    },
    required: ["cmd"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const command = (params.cmd as string) || (params.command as string) || "";
    const timeoutSecs = Math.min((params.timeout as number) ?? 30, 300);
    const timeoutMs = timeoutSecs * 1000;

    const workspace = getWorkspace(config);
    const defaultCwd = workspace ? expandPath(workspace) : process.cwd();

    let cwd: string;
    try {
      const rawCwd = (params.cwd as string) ?? defaultCwd;
      cwd = resolveInWorkspace(rawCwd, workspace);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    if (!fs.existsSync(cwd)) {
      return { ok: false, error: `Working directory not found: ${cwd}` };
    }

    // Validate cwd is inside workspace
    if (workspace && !isInsideWorkspace(cwd, workspace)) {
      return { ok: false, error: `Command references path outside workspace (${workspace})` };
    }

    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return {
          ok: false,
          error: `Command not allowed: ${reason}`,
        };
      }
    }

    // The unsandboxed path and the sandbox wrappers all assume a POSIX /bin/sh.
    // Native Windows has none, so say so instead of failing with a spawn error.
    if (os.platform() === "win32") {
      return {
        ok: false,
        error: "shell_executor needs a POSIX shell and is not supported on native Windows. Run hivecode inside WSL2.",
      };
    }

    // ── Sandbox execution ──────────────────────────────────────────
    const sandboxCfg = resolveSandboxConfig(config, workspace || cwd);
    let useSandbox = false;
    let sandboxResult: SandboxResult | null = null;

    if (sandboxCfg.enabled) {
      sandboxResult = buildSandboxCommand(command, sandboxCfg);

      if (sandboxResult.ok) {
        useSandbox = true;
        log.info(`[shell-executor] Sandbox enabled (provider: ${sandboxResult.provider})`)
      } else if (sandboxResult.reason === "unavailable") {
        log.warn(`[shell-executor] Sandbox unavailable, falling back to unsandboxed: ${sandboxResult.error}`)
        useSandbox = false;
      } else if (sandboxResult.reason === "excluded") {
        log.info(`[shell-executor] Command excluded from sandbox, running unsandboxed`)
        useSandbox = false;
      } else {
        // failIfUnavailable or other error
        return { ok: false, error: `Sandbox error: ${sandboxResult.error}` };
      }
    }

    const sandboxEnv = buildSandboxEnv(workspace || cwd);

    log.info(`Executing: ${command} (cwd=${cwd}, sandbox=${useSandbox})`);

    const t0 = performance.now();

    try {
      const controller = new AbortController();
      let proc: ReturnType<typeof Bun.spawn>;
      // Its own process group: a timeout can then stop everything the command started, not only the
      // shell. A server left running with `&` kept the output pipe open and the call never returned.
      const spawnOptions = { env: sandboxEnv, signal: controller.signal, stdout: "pipe" as const, stderr: "pipe" as const, detached: true };

      if (useSandbox && sandboxResult) {
        // Execute with sandbox isolation
        proc = spawnTaskProcess(sandboxResult.command, spawnOptions);
      } else {
        // Execute without sandbox (original behavior)
        proc = spawnTaskProcess(["/bin/sh", "-c", command], { cwd, ...spawnOptions });
      }

      const killGroup = (signal: NodeJS.Signals) => {
        try { process.kill(-proc.pid, signal); } catch { /* already gone */ }
      };
      const timeoutId = setTimeout(() => { controller.abort(); killGroup("SIGKILL"); }, timeoutMs);

      // Both streams are read at once: reading one to the end before the other can stall on a full pipe.
      const out = collectOutput(proc.stdout, () => killGroup("SIGKILL"));
      const err = collectOutput(proc.stderr, () => killGroup("SIGKILL"));
      let stdout = "";
      let stderr = "";
      let exitCode: number;

      try {
        const exited = await proc.exited;
        // The shell is done. Whatever it left running may still hold the pipes open, so wait only a
        // moment for the last of the output rather than for an end-of-file that may never come.
        await Promise.race([Promise.all([out.finished, err.finished]), new Promise(resolve => setTimeout(resolve, OUTPUT_DRAIN_MS))]);
        out.stop();
        err.stop();
        stdout = out.text();
        stderr = err.text();

        if (out.exceeded || err.exceeded) {
          killGroup("SIGKILL");
          exitCode = -1;
          stderr = stderr || `Process killed: output exceeded ${MAX_OUTPUT_BYTES} bytes`;
        } else {
          exitCode = exited;
        }

        if (exitCode !== 0 && controller.signal.aborted) {
          exitCode = -1;
          stderr = stderr || `Process killed after ${timeoutSecs}s timeout`;
        }
      } catch {
        out.stop();
        err.stop();
        exitCode = -1;
        stdout = out.text();
        stderr = err.text() || `Process killed after ${timeoutSecs}s timeout`;
      } finally {
        clearTimeout(timeoutId);
      }

      const elapsedMs = Math.round(performance.now() - t0);

      return {
        ok: exitCode === 0,
        command,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        executionTimeMs: elapsedMs,
        cwd,
        sandbox: useSandbox ? {
          enabled: true,
          provider: sandboxResult?.provider ?? null,
        } : {
          enabled: false,
          provider: null,
        },
      };
    } catch (error) {
      log.error(`Command failed: ${(error as Error).message}`);
      return {
        ok: false,
        error: `Command execution failed: ${(error as Error).message}`,
      };
    }
  },
};

export const cliExecTool = shellExecutorTool;

export function createTools(): Tool[] {
  return [shellExecutorTool];
}
