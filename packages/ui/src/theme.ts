import { TextPrompt, SelectPrompt } from "@clack/core"
import { BEE, BEE_COORDINATOR } from "./mascot.ts"
import { C } from "./ansi.ts"
import { S } from "./symbols.ts"

export { C } from "./ansi.ts"
export { S } from "./symbols.ts"
export { isCancel } from "@clack/core"

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

export function hiveProgress(coordinator = "default") {
  const color = COORDINATOR_COLOR[coordinator] ?? C.amber
  const BAR_WIDTH = 10

  return {
    render(current: number, total: number, label: string) {
      const pct = Math.round((current / total) * 100)
      const filled = Math.round((current / total) * BAR_WIDTH)
      const empty = BAR_WIDTH - filled
      const barStr = `${"■".repeat(filled)}${"□".repeat(empty)}`

      process.stdout.write(
        `${C.clearLine} ${color}${S.active}${C.reset} ` +
        `${C.dim}${label}${C.reset} ` +
        `${C.amber}${barStr}${C.reset} ` +
        `${C.white}${pct}%${C.reset} ` +
        `${C.dim}${current}/${total}${C.reset}`
      )
    },
    stop(message: string) {
      process.stdout.write(
        `${C.clearLine} ${color}${S.done}${C.reset} ${message}\n`
      )
    },
  }
}

export async function hiveText(opts: {
  message: string
  placeholder?: string
  validate?: (value: string) => string | Error | undefined
}): Promise<string | symbol> {
  const prompt = new TextPrompt({
    placeholder: opts.placeholder,
    validate: opts.validate,
    render() {
      const placeholder = opts.placeholder ? C.dim + opts.placeholder + C.reset : ""
      const display = this.value || placeholder
      let output = ` ${C.amber}${S.active}${C.reset} ${C.white}${opts.message}${C.reset}\n`
      output += ` ${bar()} ${display}`
      if (this.error) output += `\n ${bar()} ${C.red}${S.error} ${this.error}${C.reset}`
      return output
    },
  })
  return prompt.prompt()
}

export async function hiveSelect<T extends OptionLike>(opts: {
  message: string
  options: T[]
}): Promise<T["value"] | symbol> {
  const prompt = new SelectPrompt({
    options: opts.options,
    render() {
      let output = ` ${C.amber}${S.active}${C.reset} ${C.white}${opts.message}${C.reset}\n`

      for (let i = 0; i < this.options.length; i++) {
        const opt = this.options[i]
        const isSelected = i === this.cursor
        const bullet = isSelected
          ? `${C.amber}${S.bullet}${C.reset}`
          : `${C.dim}${S.dot}${C.reset}`
        const label = isSelected
          ? `${C.white}${opt.label ?? String(opt.value)}${C.reset}`
          : `${C.dim}${opt.label ?? String(opt.value)}${C.reset}`

        output += ` ${bar()} ${bullet} ${label}\n`
      }

      return output
    },
  })
  return prompt.prompt()
}

export async function hiveConfirm(opts: {
  message: string
  active?: string
  inactive?: string
  initialValue?: boolean
}): Promise<boolean | symbol> {
  const { ConfirmPrompt } = await import("@clack/core")
  const prompt = new ConfirmPrompt({
    active: opts.active ?? "Sí",
    inactive: opts.inactive ?? "No",
    initialValue: opts.initialValue ?? true,
    render() {
      const active = this.value ? `${C.green}${opts.active ?? "Sí"}${C.reset}` : `${C.dim}${opts.active ?? "Sí"}${C.reset}`
      const inactive = !this.value ? `${C.red}${opts.inactive ?? "No"}${C.reset}` : `${C.dim}${opts.inactive ?? "No"}${C.reset}`
      return ` ${C.amber}${S.active}${C.reset} ${C.white}${opts.message}${C.reset} ${active} / ${inactive}`
    },
  })
  return prompt.prompt()
}

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
      { value: "edit", label: "✏️ Editar el plan", hint: "escribe instrucciones adicionales" },
      { value: "skip", label: "⏭️ Saltar esta fase" },
      { value: "cancel", label: "❌ Cancelar todo" },
    ],
  })

  return typeof result === "symbol" ? "cancel" : result as "approve" | "edit" | "skip" | "cancel"
}
