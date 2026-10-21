/**
 * `hivecode run "<tarea>"` — una tarea sin TUI, sin gateway y sin terminal.
 *
 * La TUI necesita una terminal y el REPL se niega a arrancar sin TTY, así que el binario
 * distribuido no tenía forma de ejecutar una tarea por su cuenta: ni desde un script de CI,
 * ni desde un benchmark. Este comando es esa forma — el mismo CoordinatorManager, el mismo modo
 * automático, la misma base de datos; sólo que sin pantalla.
 *
 *   hivecode run "crea un CLI de inventario" \
 *     --out informe.json --provider opencode-go --model opencode-go/minimax-m3.1-flash-free \
 *     --max-minutes 30
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { setExecutionMode, getExecutionMode } from "@johpaz/hivecode-core/agent/execution-mode"
import { setCodeConfig } from "@johpaz/hivecode-core/storage/code-config"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { collectRunReport } from "@johpaz/hivecode-code/runtime/task-report"

const FLAGS = new Set(["--out", "--provider", "--model", "--max-minutes", "--project"])

export interface RunOptions {
  task: string
  out?: string
  provider?: string
  model?: string
  maxMinutes?: number
  project?: string
}

/** La tarea es el texto que no es bandera; el valor de cada bandera se consume con ella. */
export function parseRunFlags(args: string[]): RunOptions {
  const values: Record<string, string> = {}
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (FLAGS.has(arg)) { values[arg.slice(2)] = args[++i] ?? ""; continue }
    if (arg.startsWith("--")) continue
    words.push(arg)
  }
  return {
    task: words.join(" ").trim(),
    out: values.out,
    provider: values.provider,
    model: values.model,
    maxMinutes: values["max-minutes"] ? Number(values["max-minutes"]) : undefined,
    project: values.project,
  }
}

export async function runHeadless(args: string[]): Promise<void> {
  const options = parseRunFlags(args)
  if (!options.task) {
    console.error('uso: hivecode run "<tarea>" [--out informe.json] [--provider id] [--model id] [--max-minutes N] [--project dir]')
    process.exit(2)
  }

  const project = options.project ? resolve(options.project) : process.cwd()
  if (options.project) process.chdir(project)

  const previousMode = getExecutionMode()
  setExecutionMode("auto")
  logger.setConsole(false)
  process.env.HIVE_LOG_CONSOLE = "false"

  // Los perfiles sembrados no fijan provider ni modelo: toda la manada hereda esto.
  if (options.provider) {
    await setCodeConfig("default_provider", options.provider)
    if (options.model) await setCodeConfig(`provider_model_${options.provider}`, options.model)
  }

  const outPath = options.out ? resolve(options.out) : undefined
  const rawLog = outPath ? outPath.replace(/\.json$/, "") + ".raw.jsonl" : undefined
  if (rawLog) process.env.HIVE_LLM_RAW_LOG = rawLog

  const manager = new CoordinatorManager()
  const startedAt = Date.now()
  let final = ""
  manager.setIpcCallback((event, payload: any) => {
    if (event === "history_append" && typeof payload?.content === "string" && payload.content.startsWith("⚠")) console.log(payload.content)
  })
  manager.setTaskCompleteCallback(text => { final = text })

  await manager.startAll()
  let error: string | undefined
  let timedOut = false
  try {
    const limit = options.maxMinutes ? options.maxMinutes * 60_000 : undefined
    if (limit) {
      await Promise.race([
        manager.runTask(options.task, "auto"),
        new Promise<void>(resolveLimit => setTimeout(() => { timedOut = true; resolveLimit() }, limit)),
      ])
      if (timedOut) {
        error = `tiempo máximo (${options.maxMinutes} min) agotado`
        const id = manager.getActiveTaskId()
        if (id) {
          // Se cancela integrando: lo que el worker alcanzó a escribir se aplica al proyecto.
          // Cancelar sin integrar deja el trabajo atrapado en el worktree y el proyecto vacío.
          const cancelled = await Promise.race([
            manager.cancelTask(id, { integrate: true }).then(() => true, () => false),
            new Promise<false>(resolve => setTimeout(() => resolve(false), 120_000)),
          ])
          if (!cancelled) console.log("⚠ la cancelación no terminó en 120 s: se sigue sin ella")
        }
      }
    } else {
      await manager.runTask(options.task, "auto")
    }
  } catch (err) {
    error = (err as Error).message
  }

  const report = await collectRunReport({ project, startedAt, rawLogPath: rawLog })
  const result = { task: options.task, error: error ?? null, timedOut, finalAnswer: final.slice(0, 600), ...report }
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.log(`informe → ${outPath}`)
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
  await manager.stopAll().catch(() => {})
  setExecutionMode(previousMode)
  process.exit(error ? 1 : 0)
}
