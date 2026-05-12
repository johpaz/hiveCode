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
];

const ALLOWED_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "USER",
  "NODE_ENV",
  "BUN_INSTALL",
  "HIVE_HOME",
])

function buildSandboxEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of ALLOWED_ENV_VARS) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
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

    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return {
          ok: false,
          error: `Command not allowed: ${reason}`,
        };
      }
    }

    const sandboxEnv = buildSandboxEnv();

    log.info(`Executing: ${command} (cwd=${cwd})`);

    const t0 = performance.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const proc = Bun.spawn(["/bin/sh", "-c", command], {
        cwd,
        env: sandboxEnv,
        signal: controller.signal,
        stdout: "pipe",
        stderr: "pipe",
      });

      let stdout = "";
      let stderr = "";
      let exitCode: number;

      try {
        [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        exitCode = await proc.exited;
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
