import { BEE, BEE_COORDINATOR } from "./mascot.ts"
import { C } from "./ansi.ts"
import { S } from "./symbols.ts"

export { C } from "./ansi.ts"
export { S } from "./symbols.ts"

// Cancel sentinel — no external dep needed
const CANCEL = Symbol.for("hive.cancel")
export function isCancel(value: unknown): value is symbol {
  return typeof value === "symbol"
}

export interface OptionLike {
  value: any;
  label?: string;
  disabled?: boolean;
}

export const COORDINATOR_COLOR: Record<string, string> = {
  architecture: C.purple,
  backend: C.blue,
  frontend: C.cyan,
  security: C.red,
  test: C.green,
  devops: C.amberDim,
  principal: C.amber,
  default: C.dim,
}

export function bar(coordinator = "default"): string {
  const color = COORDINATOR_COLOR[coordinator] ?? C.dim
  return `${color}${S.bar}${C.reset}`
}

export function emptyLine(coordinator = "default"): string {
  return ` ${bar(coordinator)}`
}

export function hiveIntro(title: string): void {
  process.stdout.write(
    `\n ${BEE.happy} ${C.bold}${C.amber}${title}${C.reset}\n` +
    ` ${C.amber}${S.bar}${C.reset}\n`
  )
}

export function hiveOutro(message: string, type: "success" | "error" = "success"): void {
  const color = type === "success" ? C.green : C.red
  const symbol = type === "success" ? S.check : S.error
  process.stdout.write(
    ` ${C.amber}${S.barEnd}${C.reset} ${color}${symbol}${C.reset} ${message}\n\n`
  )
}

export function hiveModeBar(mode: "plan" | "approval" | "auto"): void {
  const labels = {
    plan: `${C.purple}PLAN${C.reset}`,
    approval: `${C.amber}APROBACIÓN${C.reset}`,
    auto: `${C.green}AUTO${C.reset}`,
  }
  process.stdout.write(
    ` ${bar()} Modo: ${labels[mode]}` +
    ` ${C.dim}[shift+tab para cambiar]${C.reset}\n` +
    ` ${bar()}\n`
  )
}

export function hivePhaseComplete(coordinator: string, summary: string): void {
  process.stdout.write(
    ` ${BEE.done} ${C.white}${summary}${C.reset}\n`
  )
}

export function hivePhaseActive(coordinator: string, message: string): void {
  const color = COORDINATOR_COLOR[coordinator] ?? C.amber
  process.stdout.write(
    ` ${color}${S.active}${C.reset} ${C.dim}${message}${C.reset}\n`
  )
}

export function hiveNote(title: string, lines: string[]): void {
  const width = Math.max(title.length + 4, ...lines.map(l => l.length + 4), 44)
  const top = `┌─ ${C.amber}${title}${C.reset} ${"─".repeat(width - title.length - 4)}┐`
  const bottom = `└${"─".repeat(width)}┘`

  process.stdout.write(`\n ${top}\n`)
  for (const line of lines) {
    const padding = " ".repeat(width - line.length - 2)
    process.stdout.write(` ${C.dim}│${C.reset} ${line}${padding}${C.dim}│${C.reset}\n`)
  }
  process.stdout.write(` ${bottom}\n\n`)
}

export function hiveSpinner(coordinator = "default") {
  const frames = [BEE.thinking, BEE.plan, BEE.thinking]
  const color = COORDINATOR_COLOR[coordinator] ?? C.amber
  let i = 0
  let interval: ReturnType<typeof setInterval> | null = null
  let currentMsg = ""

  return {
    start(message: string) {
      currentMsg = message
      interval = setInterval(() => {
        const frame = frames[i++ % frames.length]
        process.stdout.write(
          `${C.clearLine} ${color}${frame}${C.reset} ${C.dim}${currentMsg}${C.reset}`
        )
      }, 120)
    },
    update(message: string) {
      currentMsg = message
    },
    stop(message: string, type: "done" | "error" = "done") {
      if (interval) clearInterval(interval)
      const symbol = type === "done" ? S.done : S.error
      const msgColor = type === "done" ? C.white : C.red
      process.stdout.write(
        `${C.clearLine} ${color}${symbol}${C.reset} ${msgColor}${message}${C.reset}\n`
      )
    },
  }
}



// ─── Inline prompt helpers ────────────────────────────────────────────────────
// Pure raw-mode TTY — no external deps.

function stdinCleanup(handler: (key: string) => void) {
  process.stdin.setRawMode(false)
  process.stdin.removeListener("data", handler)
  // Intentionally NOT calling pause() — pausing buffers pending stdin bytes
  // (e.g. the \r that closed the previous prompt) which then replay into the
  // next prompt's listener as a phantom keypress.
}

export async function hiveText(opts: {
  message: string
  placeholder?: string
  password?: boolean
  validate?: (value: string) => string | Error | undefined
}): Promise<string | symbol> {
  return new Promise((resolve) => {
    let input = ""
    let error = ""
    let prevLines = 0

    const render = () => {
      if (prevLines > 0) process.stdout.write(`\x1b[${prevLines}A\r\x1b[J`)
      const display = input !== ""
        ? opts.password
          ? `${C.amber}${"*".repeat(input.length)}${C.reset}`
          : `${C.white}${input}${C.reset}`
        : opts.placeholder ? `${C.dim}${opts.placeholder}${C.reset}` : ""
      let out = ` ${C.amber}${S.active}${C.reset} ${C.white}${opts.message}${C.reset}\n`
      out += ` ${bar()} ${display}\n`
      if (error) out += ` ${bar()} ${C.red}${S.error} ${error}${C.reset}\n`
      prevLines = 2 + (error ? 1 : 0)
      process.stdout.write(out)
    }

    render()
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")

    const onKey = (key: string) => {
      if (key === "\x03") {
        stdinCleanup(onKey); resolve(CANCEL)
      } else if (key === "\x7f" || key === "\b") {
        input = input.slice(0, -1); error = ""; render()
      } else if (key === "\r") {
        if (opts.validate) {
          const err = opts.validate(input)
          if (err) { error = err instanceof Error ? err.message : err; render(); return }
        }
        stdinCleanup(onKey); resolve(input)
      } else if (key === "\x1b") {
        stdinCleanup(onKey); resolve(CANCEL)
      } else if (!key.startsWith("\x1b")) {
        // single keypress or multi-char paste — filter printable chars
        let changed = false
        for (const ch of key) {
          const code = ch.charCodeAt(0)
          if (code >= 32 && code !== 127) { input += ch; changed = true }
        }
        if (changed) { error = ""; render() }
      }
    }

    process.stdin.on("data", onKey)
  })
}

export async function hiveSelect<T extends OptionLike>(opts: {
  message: string
  options: T[]
}): Promise<T["value"] | symbol> {
  return new Promise((resolve) => {
    let cursor = 0
    const { options } = opts
    let prevLines = 0

    const render = () => {
      if (prevLines > 0) process.stdout.write(`\x1b[${prevLines}A\r\x1b[J`)
      let out = ` ${C.amber}${S.active}${C.reset} ${C.white}${opts.message}${C.reset}\n`
      for (let i = 0; i < options.length; i++) {
        const opt = options[i]
        const sel = i === cursor
        const bullet = sel ? `${C.amber}${S.bullet}${C.reset}` : `${C.dim}${S.dot}${C.reset}`
        const label = sel
          ? `${C.white}${opt.label ?? String(opt.value)}${C.reset}`
          : `${C.dim}${opt.label ?? String(opt.value)}${C.reset}`
        out += ` ${bar()} ${bullet} ${label}\n`
      }
      prevLines = options.length + 1
      process.stdout.write(out)
    }

    render()
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")

    const onKey = (key: string) => {
      if (key === "\x03") {
        stdinCleanup(onKey); resolve(CANCEL)
      } else if (key === "\x1b[A") {
        cursor = (cursor - 1 + options.length) % options.length; render()
      } else if (key === "\x1b[B") {
        cursor = (cursor + 1) % options.length; render()
      } else if (key === "\r") {
        stdinCleanup(onKey); resolve(options[cursor].value)
      } else if (key === "\x1b") {
        stdinCleanup(onKey); resolve(CANCEL)
      }
    }

    process.stdin.on("data", onKey)
  })
}

export async function hiveConfirm(opts: {
  message: string
  active?: string
  inactive?: string
  initialValue?: boolean
}): Promise<boolean | symbol> {
  return new Promise((resolve) => {
    let value = opts.initialValue ?? true
    const yes = opts.active ?? "Sí"
    const no = opts.inactive ?? "No"
    let prevLines = 0

    const render = () => {
      if (prevLines > 0) process.stdout.write(`\x1b[${prevLines}A\r\x1b[J`)
      const yesLabel = value  ? `${C.green}${yes}${C.reset}` : `${C.dim}${yes}${C.reset}`
      const noLabel  = !value ? `${C.red}${no}${C.reset}`   : `${C.dim}${no}${C.reset}`
      process.stdout.write(
        ` ${C.amber}${S.active}${C.reset} ${C.white}${opts.message}${C.reset} ${yesLabel} / ${noLabel}\n`
      )
      prevLines = 1
    }

    render()
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")

    const onKey = (key: string) => {
      if (key === "\x03") {
        stdinCleanup(onKey); resolve(CANCEL)
      } else if (key === "\x1b[C" || key === "\x1b[D") {
        value = !value; render()
      } else if (key === "y" || key === "Y") {
        value = true; render()
      } else if (key === "n" || key === "N") {
        value = false; render()
      } else if (key === "\r") {
        stdinCleanup(onKey); resolve(value)
      } else if (key === "\x1b") {
        stdinCleanup(onKey); resolve(CANCEL)
      }
    }

    process.stdin.on("data", onKey)
  })
}

// ─── Checkpoint (approval flow) ───────────────────────────────────────────────

export async function hiveCheckpoint(opts: {
  coordinator: string
  phaseNumber: number
  totalPhases: number
  completed?: {
    filesCreated: string[]
    filesModified: string[]
    summary: string
  }
  upcoming: {
    coordinator: string
    willCreate: { path: string; reason: string }[]
    willModify: { path: string; lines: string; reason: string }[]
  }
}): Promise<"approve" | "edit" | "skip" | "cancel"> {
  const { completed, upcoming, phaseNumber, totalPhases } = opts
  const upColor = COORDINATOR_COLOR[upcoming.coordinator] ?? C.amber

  if (completed) {
    process.stdout.write(
      `\n ${C.green}${S.done}${C.reset} ` +
      `${C.white}Fase ${phaseNumber - 1}/${totalPhases} completada${C.reset} ` +
      `${C.dim}${completed.summary}${C.reset}\n`
    )
    for (const f of completed.filesCreated) {
      process.stdout.write(` ${bar()} ${C.green}+${C.reset} ${C.dim}${f}${C.reset}\n`)
    }
    for (const f of completed.filesModified) {
      process.stdout.write(` ${bar()} ${C.amber}~${C.reset} ${C.dim}${f}${C.reset}\n`)
    }
  }

  process.stdout.write(
    `\n ${upColor}${S.active}${C.reset} ` +
    `${C.white}Fase ${phaseNumber}/${totalPhases}: ${upcoming.coordinator}${C.reset}\n`
  )
  for (const f of upcoming.willCreate) {
    process.stdout.write(
      ` ${bar(upcoming.coordinator)} ${C.green}+${C.reset} crear ` +
      `${C.white}${f.path}${C.reset} ${C.dim}${f.reason}${C.reset}\n`
    )
  }
  for (const f of upcoming.willModify) {
    process.stdout.write(
      ` ${bar(upcoming.coordinator)} ${C.amber}~${C.reset} modificar ` +
      `${C.white}${f.path}${C.reset} ${C.dim}${f.lines}${C.reset}\n`
    )
  }

  const result = await hiveSelect({
    message: "¿Qué deseas hacer?",
    options: [
      { value: "approve", label: "✅ Aprobar y continuar" },
      { value: "edit",    label: "✏️ Editar el plan" },
      { value: "skip",    label: "⏭️ Saltar esta fase" },
      { value: "cancel",  label: "❌ Cancelar todo" },
    ],
  })

  return typeof result === "symbol" ? "cancel" : result as "approve" | "edit" | "skip" | "cancel"
}
