import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

const CANCEL = Symbol.for("hive.cancel")

export function isCancel(value: unknown): value is symbol {
  return typeof value === "symbol"
}

export interface OptionLike {
  value: any
  label?: string
  disabled?: boolean
}

const C = {
  amber: "\x1b[38;5;214m",
  green: "\x1b[38;5;114m",
  red: "\x1b[38;5;203m",
  blue: "\x1b[38;5;111m",
  purple: "\x1b[38;5;141m",
  cyan: "\x1b[38;5;116m",
  white: "\x1b[38;5;252m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
  clearLine: "\x1b[2K\r",
} as const

const coordinatorColor: Record<string, string> = {
  architecture: C.purple,
  backend: C.blue,
  frontend: C.cyan,
  security: C.red,
  test: C.green,
  devops: C.amber,
  principal: C.amber,
  default: C.dim,
}

function colorFor(coordinator = "default"): string {
  return coordinatorColor[coordinator] ?? C.dim
}

async function question(message: string): Promise<string | symbol> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return await rl.question(message)
  } catch {
    return CANCEL
  } finally {
    rl.close()
  }
}

function secretQuestion(message: string): Promise<string | symbol> {
  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      question(message).then(resolve)
      return
    }

    let value = ""
    stdout.write(message)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")

    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.removeListener("data", onKey)
      stdout.write("\n")
    }

    const onKey = (key: string) => {
      if (key === "\x03" || key === "\x1b") {
        cleanup()
        resolve(CANCEL)
      } else if (key === "\r" || key === "\n") {
        cleanup()
        resolve(value)
      } else if (key === "\x7f" || key === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1)
          stdout.write("\b \b")
        }
      } else if (!key.startsWith("\x1b")) {
        for (const ch of key) {
          const code = ch.charCodeAt(0)
          if (code >= 32 && code !== 127) {
            value += ch
            stdout.write("*")
          }
        }
      }
    }

    stdin.on("data", onKey)
  })
}

export function hiveIntro(title: string): void {
  stdout.write(`\n ${C.bold}${C.amber}${title}${C.reset}\n`)
}

export function hiveOutro(message: string, type: "success" | "error" = "success"): void {
  const color = type === "success" ? C.green : C.red
  const symbol = type === "success" ? "✓" : "✗"
  stdout.write(` ${color}${symbol}${C.reset} ${message}\n\n`)
}

export function hiveModeBar(mode: "plan" | "approval" | "auto"): void {
  const labels = {
    plan: `${C.purple}PLAN${C.reset}`,
    approval: `${C.amber}APROBACIÓN${C.reset}`,
    auto: `${C.green}AUTO${C.reset}`,
  }
  stdout.write(` Modo: ${labels[mode]} ${C.dim}[shift+tab para cambiar]${C.reset}\n`)
}

export function hivePhaseComplete(_coordinator: string, summary: string): void {
  stdout.write(` ${C.green}✓${C.reset} ${summary}\n`)
}

export function hivePhaseActive(coordinator: string, message: string): void {
  stdout.write(` ${colorFor(coordinator)}⬡${C.reset} ${C.dim}${message}${C.reset}\n`)
}

export function hiveNote(title: string, lines: string[]): void {
  stdout.write(`\n ${C.amber}${title}${C.reset}\n`)
  for (const line of lines) stdout.write(`   ${line}\n`)
  stdout.write("\n")
}

export function hiveSpinner(coordinator = "default") {
  let current = ""
  return {
    start(message: string) {
      current = message
      stdout.write(` ${colorFor(coordinator)}…${C.reset} ${C.dim}${message}${C.reset}`)
    },
    update(message: string) {
      current = message
      stdout.write(`${C.clearLine} ${colorFor(coordinator)}…${C.reset} ${C.dim}${message}${C.reset}`)
    },
    stop(message: string, type: "done" | "warn" | "error" = "done") {
      const symbol = type === "done" ? "✓" : type === "warn" ? "▲" : "✗"
      const color = type === "done" ? C.green : type === "warn" ? C.amber : C.red
      stdout.write(`${C.clearLine} ${color}${symbol}${C.reset} ${message || current}\n`)
    },
  }
}

export async function hiveText(opts: {
  message: string
  placeholder?: string
  password?: boolean
  validate?: (value: string) => string | Error | undefined
}): Promise<string | symbol> {
  const suffix = opts.placeholder ? ` (${opts.placeholder})` : ""
  const value = opts.password
    ? await secretQuestion(` ${opts.message}${suffix}: `)
    : await question(` ${opts.message}${suffix}: `)
  if (isCancel(value)) return value

  const error = opts.validate?.(value)
  if (error) {
    stdout.write(` ${C.red}${error instanceof Error ? error.message : error}${C.reset}\n`)
    return hiveText(opts)
  }
  return value
}

export async function hiveSelect<T extends OptionLike>(opts: {
  message: string
  options: T[]
}): Promise<T["value"] | symbol> {
  stdout.write(` ${opts.message}\n`)
  opts.options.forEach((option, index) => {
    const label = option.label ?? String(option.value)
    stdout.write(`   ${index + 1}. ${label}${option.disabled ? " (disabled)" : ""}\n`)
  })

  while (true) {
    const answer = await question(" Selección: ")
    if (isCancel(answer)) return answer
    const idx = answer.trim() === "" ? 0 : Number(answer.trim()) - 1
    const option = opts.options[idx]
    if (option && !option.disabled) return option.value
    stdout.write(` ${C.red}Selección inválida${C.reset}\n`)
  }
}

export async function hiveConfirm(opts: {
  message: string
  active?: string
  inactive?: string
  initialValue?: boolean
}): Promise<boolean | symbol> {
  const yes = opts.active ?? "Sí"
  const no = opts.inactive ?? "No"
  const defaultValue = opts.initialValue ?? true
  const answer = await question(` ${opts.message} ${yes}/${no} [${defaultValue ? yes : no}]: `)
  if (isCancel(answer)) return answer
  const normalized = answer.trim().toLowerCase()
  if (!normalized) return defaultValue
  return normalized === "y" || normalized === "yes" || normalized === "s" || normalized === "si" || normalized === "sí"
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
  if (opts.completed) {
    hivePhaseComplete(opts.coordinator, `Fase ${opts.phaseNumber - 1}/${opts.totalPhases}: ${opts.completed.summary}`)
    for (const file of opts.completed.filesCreated) stdout.write(`   + ${file}\n`)
    for (const file of opts.completed.filesModified) stdout.write(`   ~ ${file}\n`)
  }

  hivePhaseActive(opts.upcoming.coordinator, `Fase ${opts.phaseNumber}/${opts.totalPhases}`)
  for (const file of opts.upcoming.willCreate) stdout.write(`   + crear ${file.path} ${C.dim}${file.reason}${C.reset}\n`)
  for (const file of opts.upcoming.willModify) stdout.write(`   ~ modificar ${file.path} ${C.dim}${file.lines} ${file.reason}${C.reset}\n`)

  const result = await hiveSelect({
    message: "¿Qué deseas hacer?",
    options: [
      { value: "approve", label: "Aprobar y continuar" },
      { value: "edit", label: "Editar el plan" },
      { value: "skip", label: "Saltar esta fase" },
      { value: "cancel", label: "Cancelar todo" },
    ],
  })
  return isCancel(result) ? "cancel" : result as "approve" | "edit" | "skip" | "cancel"
}

export interface ProviderSetupResult {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
}

function getModelsForProvider(providerId: string): { value: string; label: string }[] {
  try {
    const rows = getDb()
      .query("SELECT id, name FROM models WHERE provider_id = ? AND model_type = 'llm' ORDER BY name")
      .all(providerId) as { id: string; name: string }[]
    return rows.map((row) => ({ value: row.id, label: row.name }))
  } catch {
    return []
  }
}

export async function runProviderSetupWizard(
  knownProviders: string[] = [],
  version = "1.0.0",
): Promise<ProviderSetupResult | null> {
  hiveIntro(`hivecode v${version} · Configurar provider`)

  let provider = ""
  if (knownProviders.length > 0) {
    const selected = await hiveSelect({
      message: "Provider:",
      options: knownProviders.map((value) => ({ value, label: value })),
    })
    if (isCancel(selected)) return null
    provider = selected as string
  } else {
    const input = await hiveText({ message: "Nombre del provider", placeholder: "anthropic, openai, groq..." })
    if (isCancel(input) || !input) return null
    provider = input
  }

  const apiKey = await hiveText({
    message: `API Key para ${provider}`,
    placeholder: "sk-...",
    password: true,
    validate: (value) => !value.trim() ? "La API key no puede estar vacía" : undefined,
  })
  if (isCancel(apiKey)) return null

  const baseUrl = await hiveText({ message: "Base URL opcional", placeholder: "https://api.anthropic.com" })
  if (isCancel(baseUrl)) return null

  let model = ""
  const dbModels = getModelsForProvider(provider)
  if (dbModels.length > 0) {
    const selected = await hiveSelect({
      message: `Modelo para ${provider}:`,
      options: [...dbModels, { value: "__custom__", label: "Otro (escribir manualmente)" }],
    })
    if (isCancel(selected)) return null
    if (selected === "__custom__") {
      const custom = await hiveText({ message: "Nombre del modelo", placeholder: "claude-sonnet-4-6, gpt-4o..." })
      if (!isCancel(custom)) model = custom
    } else {
      model = selected as string
    }
  } else {
    const input = await hiveText({
      message: "Modelo por defecto opcional",
      placeholder: "claude-sonnet-4-6, gpt-4o, llama3-70b...",
    })
    if (!isCancel(input)) model = input
  }

  return {
    provider,
    apiKey,
    baseUrl: isCancel(baseUrl) ? "" : baseUrl,
    model,
  }
}

export interface TelegramSetupResult {
  botToken: string
  dmPolicy: "open" | "allowlist"
  groups: boolean
  allowFrom: string[]
}

export async function runTelegramConnectWizard(): Promise<TelegramSetupResult | null> {
  hiveIntro("hivecode · Conectar Telegram")

  const botToken = await hiveText({ message: "Bot Token", placeholder: "123456789:AAF..." })
  if (isCancel(botToken) || !botToken) return null

  const dmPolicyRaw = await hiveSelect({
    message: "Política de mensajes directos:",
    options: [
      { value: "open", label: "Abierto" },
      { value: "allowlist", label: "Lista blanca" },
    ],
  })
  if (isCancel(dmPolicyRaw)) return null

  let allowFrom: string[] = []
  if (dmPolicyRaw === "allowlist") {
    const ids = await hiveText({ message: "IDs permitidos separados por coma", placeholder: "tg:123456,tg:789012" })
    if (isCancel(ids)) return null
    allowFrom = ids.split(",").map((value) => value.trim()).filter(Boolean)
  }

  const groups = await hiveConfirm({ message: "¿Habilitar soporte de grupos de Telegram?", initialValue: false })
  if (isCancel(groups)) return null

  return {
    botToken,
    dmPolicy: dmPolicyRaw as "open" | "allowlist",
    groups,
    allowFrom,
  }
}
