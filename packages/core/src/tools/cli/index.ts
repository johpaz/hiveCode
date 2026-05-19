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
  { pattern: />\s*\/dev\//, reason: "write to device file" },
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

function buildSandboxEnv(workspace: string): Record<string, string | undefined> {
  const isolatedTaskDir = workspace || path.join(os.tmpdir(), `hive-sandbox-${Date.now()}`);
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
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

export const shellExecutorTool: Tool = {
  name: "shell_executor",
  description: "Execute shell/bash commands in the agent workspace. NOTE: do NOT use for scheduling tasks, use cron.create instead. Spanish: ejecutar comando, terminal, bash, script, consola",
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

    // ── Sandbox execution ──────────────────────────────────────────
    const sandboxCfg = resolveSandboxConfig(config, workspace || cwd);
    let useSandbox = false;
    let sandboxResult: SandboxResult | null = null;

    if (sandboxCfg.enabled) {
      sandboxResult = buildSandboxCommand(command, sandboxCfg);

      if (sandboxResult.ok) {
        useSandbox = true;
        log.info(`[shell-executor] Sandbox enabled (provider: ${sandboxResult.provider})`)
      } else if (sandboxResult.error?.includes("falling back")) {
        log.warn(`[shell-executor] Sandbox unavailable, falling back to unsandboxed: ${sandboxResult.error}`)
        useSandbox = false;
      } else if (sandboxResult.error?.includes("excluded")) {
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
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let proc: ReturnType<typeof Bun.spawn>;

      if (useSandbox && sandboxResult) {
        // Execute with sandbox isolation
        proc = Bun.spawn(sandboxResult.command, {
          env: sandboxEnv,
          signal: controller.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
      } else {
        // Execute without sandbox (original behavior)
        proc = Bun.spawn(["/bin/sh", "-c", command], {
          cwd,
          env: sandboxEnv,
          signal: controller.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
      }

      let stdout = "";
      let stderr = "";
      let exitCode: number;
      let outputExceeded = false;

      try {
        // Read stdout with 10MB limit
        const stdoutStream = proc.stdout;
        if (stdoutStream && typeof stdoutStream === "object" && "getReader" in stdoutStream) {
          const stdoutReader = (stdoutStream as ReadableStream<Uint8Array>).getReader();
          const stdoutChunks: Uint8Array[] = [];
          let stdoutBytes = 0;
          while (true) {
            const { done, value } = await stdoutReader.read();
            if (done) break;
            stdoutBytes += value.length;
            if (stdoutBytes > MAX_OUTPUT_BYTES) {
              outputExceeded = true;
              break;
            }
            stdoutChunks.push(value);
          }
          stdout = new TextDecoder().decode(Buffer.concat(stdoutChunks));
        }

        // Read stderr with 10MB limit
        const stderrStream = proc.stderr;
        if (stderrStream && typeof stderrStream === "object" && "getReader" in stderrStream) {
          const stderrReader = (stderrStream as ReadableStream<Uint8Array>).getReader();
          const stderrChunks: Uint8Array[] = [];
          let stderrBytes = 0;
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;
            stderrBytes += value.length;
            if (stderrBytes > MAX_OUTPUT_BYTES) {
              outputExceeded = true;
              break;
            }
            stderrChunks.push(value);
          }
          stderr = new TextDecoder().decode(Buffer.concat(stderrChunks));
        }

        if (outputExceeded) {
          try { proc.kill("SIGKILL"); } catch { /* ignore */ }
          exitCode = -1;
          stderr = stderr || `Process killed: output exceeded ${MAX_OUTPUT_BYTES} bytes`;
        } else {
          exitCode = await proc.exited;
        }

        if (exitCode !== 0 && controller.signal.aborted) {
          exitCode = -1;
          stderr = stderr || `Process killed after ${timeoutSecs}s timeout`;
        }
      } catch {
        exitCode = -1;
        stdout = stdout || "";
        stderr = stderr || `Process killed after ${timeoutSecs}s timeout`;
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
