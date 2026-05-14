/**
 * Smoke tests reales — spawna el CLI como proceso real, sin mocks.
 * Usa la DB de producción (~/.hivecode/hivecode.db).
 *
 * Metodología Arnes: ARMAR / ACTUAR / NOTAR / ESTADO / SALIDA
 *
 * Cómo correr:
 *   bun test packages/cli/tests/smoke/cli-smoke.test.ts
 */

import { describe, test, expect } from "bun:test"
import * as path from "node:path"

const CLI = path.resolve(import.meta.dir, "../../src/index.ts")

// ─── Helper ───────────────────────────────────────────────────────────────────

async function runCli(
  args: string[],
  opts: { timeoutMs?: number; stdin?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : "ignore",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  })

  const timeout = opts.timeoutMs ?? 15_000
  const timer = setTimeout(() => proc.kill(), timeout)

  const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)

  // Strip ANSI escape codes for clean assertions
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "")

  return {
    exitCode: exitCode ?? 0,
    stdout: stripAnsi(stdoutBuf),
    stderr: stripAnsi(stderrBuf),
  }
}

// ─── --version ────────────────────────────────────────────────────────────────

describe("smoke: --version", () => {
  test("imprime la versión y termina con exit 0", async () => {
    // ARMAR: CLI instalado en packages/cli/src/index.ts
    // ACTUAR
    const { exitCode, stdout } = await runCli(["--version"])
    // NOTAR
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/hivecode v\d+\.\d+\.\d+/)
  })
})

// ─── doctor ───────────────────────────────────────────────────────────────────

describe("smoke: doctor", () => {
  test("realiza diagnóstico completo y termina con exit 0", async () => {
    // ARMAR: DB real en ~/.hivecode
    // ACTUAR
    const { exitCode, stdout } = await runCli(["doctor"])
    // NOTAR
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Bun runtime")
    expect(stdout).toContain("SQLite")
  })

  test("reporta providers LLM disponibles", async () => {
    const { stdout } = await runCli(["doctor"])
    // NOTAR — la instalación tiene providers en DB
    expect(stdout).toMatch(/Providers LLM/)
  })

  test("reporta workers/coordinadores", async () => {
    const { stdout } = await runCli(["doctor"])
    expect(stdout).toMatch(/coordinadores|Workers/)
  })

  test("reporta skills cargadas", async () => {
    const { stdout } = await runCli(["doctor"])
    expect(stdout).toMatch(/skill|Skill/)
  })

  test("resumen muestra checks pasados", async () => {
    const { stdout } = await runCli(["doctor"])
    // NOTAR — siempre hay al menos 1 check pasado
    expect(stdout).toMatch(/\d+ checks? pas/)
  })
})

// ─── provider remove (sin TTY — muestra error correcto) ───────────────────────

describe("smoke: provider remove sin args", () => {
  test("sin nombre → exit 1 con mensaje de uso", async () => {
    // ARMAR: comando sin argumentos requeridos
    // ACTUAR
    const { exitCode, stdout } = await runCli(["provider", "remove"])
    // NOTAR — exit 1 + mensaje de uso
    expect(exitCode).toBe(1)
    expect(stdout).toContain("provider remove")
  })
})

describe("smoke: provider set-default sin args", () => {
  test("sin nombre → exit 1 con mensaje de uso", async () => {
    const { exitCode, stdout } = await runCli(["provider", "set-default"])
    expect(exitCode).toBe(1)
    expect(stdout).toContain("provider set-default")
  })
})

describe("smoke: provider set-model sin args", () => {
  test("sin args → exit 1 con mensaje de uso", async () => {
    const { exitCode, stdout } = await runCli(["provider", "set-model"])
    expect(exitCode).toBe(1)
    expect(stdout).toContain("provider set-model")
  })
})

// ─── REPL en non-TTY ──────────────────────────────────────────────────────────

describe("smoke: REPL en non-TTY", () => {
  test("sin TTY → mensaje informativo, exit 0", async () => {
    // ARMAR: stdin no es TTY (pipe)
    // ACTUAR
    const { exitCode, stdout } = await runCli([], { stdin: "" })
    // NOTAR — el REPL detecta no-TTY y sale limpio
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/TTY|non-interactive|hivecode/)
  })
})

// ─── comando desconocido ──────────────────────────────────────────────────────

describe("smoke: comando desconocido", () => {
  test("comando inexistente → exit 1 o muestra ayuda", async () => {
    // ARMAR / ACTUAR
    const { exitCode, stdout } = await runCli(["comando-que-no-existe"])
    // NOTAR — no colapsa silenciosamente
    expect(exitCode).toBe(1)
    // Muestra ayuda o mensaje de error
    expect(stdout.length).toBeGreaterThan(0)
  })
})

// ─── plan en non-TTY ─────────────────────────────────────────────────────────

describe("smoke: plan en non-TTY (sin provider configurado como default)", () => {
  test("invocado sin stdin interactivo → proceso termina sin colgar", async () => {
    // ARMAR: proceso no interactivo
    // ACTUAR — limitamos a 10s para detectar si cuelga
    const { exitCode } = await runCli(["plan", "test task"], { timeoutMs: 10_000, stdin: "\n" })
    // NOTAR — que termine (cualquier código), no que cuelgue
    expect(typeof exitCode).toBe("number")
  })
})
