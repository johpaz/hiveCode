/**
 * One measured run of a task, with no TUI, so that two configurations can be compared fairly.
 *
 *   bun scripts/bench-run.ts --project ~/Agents/Bee --reset --out /tmp/bench/base.json \
 *       --task "crea un proyecto bun llamado inventario: …"
 *
 * It runs the task in `auto` mode exactly as the TUI would (CoordinatorManager.runTask), then reads
 * what the run left in HiveDB (runs, tokens, blockers, revisions, concurrency), the odd model
 * responses it logged (HIVE_LLM_RAW_LOG) and whether the delivered project works (`bun test`).
 * Everything goes to --out as JSON plus a short table on stdout. Run it once per configuration and
 * compare the JSON files: it is how Jev/Kev were measured before they were removed.
 *
 * Progress is announced as it happens: a blocked worker or a failed integration is printed at once
 * with a "⚠", and a run that goes quiet for too long prints an "ALERTA", because a silent stall
 * is the worst outcome of all.
 *
 * `--reset` wipes the project (git reset --hard && git clean -fdx, task worktrees and branches).
 * It is meant for a throwaway project and is refused unless asked for explicitly.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    task: { type: "string" },
    // The prompt in a file instead of argv: the process list would otherwise carry the whole prompt, and an
    // agent that runs `pkill -f server.ts` (or any pattern the prompt mentions) would kill this very process.
    "task-file": { type: "string" },
    out: { type: "string" },
    reset: { type: "boolean", default: false },
    "max-minutes": { type: "string", default: "55" },
    "stall-minutes": { type: "string", default: "7" },
    "grace-minutes": { type: "string", default: "2" },
    // Internal: the run itself (the parent only supervises it), and reading what a killed run left behind.
    child: { type: "boolean", default: false },
    "collect-only": { type: "boolean", default: false },
    "started-at": { type: "string" },
  },
})
if (values["task-file"] && !values.task) values.task = readFileSync(values["task-file"], "utf-8").trim()
if (!values.project || !values.task || !values.out) {
  console.error("uso: bun scripts/bench-run.ts --project <dir> (--task <texto> | --task-file <archivo>) --out <archivo.json> [--reset]")
  process.exit(2)
}

// ── Supervisor ──────────────────────────────────────────────────────────────────────────────
// The run does its own timeout, but a process that stops answering (a stuck native call, a cancel that never
// returns) cannot be trusted to enforce it. So the run lives in a child; if the child outlives the limit by
// more than a short grace, it is killed with everything it started and the metrics are read from the database.
if (!values.child && !values["collect-only"]) {
  const argv = process.argv.slice(2)
  const startedAt = Date.now()
  const graceMs = Number(values["grace-minutes"]) * 60_000
  const hardMs = Number(values["max-minutes"]) * 60_000 + graceMs
  const child = Bun.spawn([process.execPath, import.meta.path, ...argv, "--child"], { stdio: ["inherit", "inherit", "inherit"], detached: true })
  let hung = false
  const killer = setTimeout(() => {
    hung = true
    console.log(`[${new Date().toISOString().slice(11, 19)}] ✗ COLGADO: la corrida siguió viva ${values["grace-minutes"]} min después del tiempo máximo. Se mata con todo lo que lanzó.`)
    try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
  }, hardMs)
  const code = await child.exited
  clearTimeout(killer)
  if (hung) {
    const collect = Bun.spawn([process.execPath, import.meta.path, ...argv, "--collect-only", "--started-at", String(startedAt)], { stdio: ["inherit", "inherit", "inherit"] })
    await collect.exited
    process.exit(3)
  }
  process.exit(code ?? 0)
}

const project = resolve(values.project)
const out = resolve(values.out)
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@local", ...args], { cwd: project, stdio: "pipe" }).toString()

if (!existsSync(`${project}/.git`)) { console.error(`✗ ${project} no es un repositorio git`); process.exit(2) }
mkdirSync(dirname(out), { recursive: true })

if (values.reset && !values["collect-only"]) {
  for (const line of git("worktree", "list", "--porcelain").split("\n")) {
    const path = /^worktree (.+)$/.exec(line)?.[1]
    if (path && path !== project) { try { git("worktree", "remove", "--force", path) } catch { /* already gone */ } }
  }
  git("worktree", "prune")
  for (const branch of git("branch", "--list", "hivecode/*").split("\n").map(b => b.replace(/^[*+\s]+/, "")).filter(Boolean)) { try { git("branch", "-D", branch) } catch { /* in use */ } }
  git("reset", "--hard"); git("clean", "-fdxq")
}

const rawLog = out.replace(/\.json$/, "") + ".raw.jsonl"
rmSync(rawLog, { force: true })
process.env.HIVE_LLM_RAW_LOG = rawLog
process.env.HIVE_LOG_CONSOLE = "false"
process.chdir(project)

const { CoordinatorManager } = await import("../packages/code/src/workers/coordinator-manager")
const { setExecutionMode, getExecutionMode } = await import("../packages/core/src/agent/execution-mode")
const { col } = await import("../packages/core/src/storage/hive")
const { logger } = await import("../packages/core/src/utils/logger")
logger.setConsole(false)

const stamp = () => new Date().toISOString().slice(11, 19)
const say = (line: string) => console.log(`[${stamp()}] ${line}`)

const collectOnly = values["collect-only"] === true
const previousMode = getExecutionMode()
if (!collectOnly) setExecutionMode("auto")
const manager = collectOnly ? null : new CoordinatorManager()
let lastEvent = Date.now()
let final = ""
const warnings: string[] = []
manager?.setIpcCallback((event, payload: any) => {
  lastEvent = Date.now()
  if (event === "history_append" && typeof payload?.content === "string" && payload.content.startsWith("⚠")) {
    warnings.push(payload.content)
    say(payload.content)
  }
  if (event === "conflict_alert") say(`⚠ ALERTA de integración: ${payload?.reason ?? ""} ${String(payload?.detail ?? "").split("\n")[0].slice(0, 160)}`)
})
manager?.setTaskCompleteCallback(text => { final = text })

const startedAt = collectOnly ? Number(values["started-at"]) : Date.now()
say(collectOnly ? `recogiendo lo que dejó una corrida colgada (desde ${new Date(startedAt).toISOString().slice(11, 19)})` : `arranca: proyecto=${project}`)
await manager?.startAll()

const stallMs = Number(values["stall-minutes"]) * 60_000
const watchdog = collectOnly ? undefined : setInterval(() => {
  const quiet = Date.now() - lastEvent
  if (quiet > stallMs) { say(`ALERTA: ${Math.round(quiet / 60000)} min sin ningún evento del coordinador`); lastEvent = Date.now() }
}, 30_000)
const heartbeat = collectOnly ? undefined : setInterval(() => say(`latido: ${Math.round((Date.now() - startedAt) / 60000)} min`), 120_000)

let error: string | undefined
let timedOut = false
if (collectOnly) {
  error = "colgada: el proceso dejó de responder y hubo que matarlo; las cifras son lo que alcanzó a guardar"
} else {
  const limit = new Promise<void>(resolveLimit => setTimeout(() => { timedOut = true; resolveLimit() }, Number(values["max-minutes"]) * 60_000))
  try {
    await Promise.race([manager!.runTask(values.task!, "auto"), limit])
    if (timedOut) {
      error = `tiempo máximo (${values["max-minutes"]} min) agotado`
      const id = manager!.getActiveTaskId()
      say(`tiempo máximo alcanzado: cancelando la tarea ${id ? id.slice(0, 8) : "(sin id activo)"}`)
      if (id) {
        // Cancelling is bounded here as well: a cancel that never returns must not hold the report hostage.
        const cancelled = await Promise.race([manager!.cancelTask(id).then(() => true, () => false), new Promise<false>(r => setTimeout(() => r(false), 60_000))])
        say(cancelled ? "tarea cancelada" : "⚠ la cancelación no terminó en 60 s: se sigue sin ella")
      }
    }
  } catch (err) {
    error = (err as Error).message
    say(`✗ la tarea falló: ${error.slice(0, 200)}`)
  }
}
clearInterval(watchdog); clearInterval(heartbeat)
const finishedAt = Date.now()
say(`terminó en ${((finishedAt - startedAt) / 60000).toFixed(1)} min${error ? ` (con error)` : ""}`)

// ── What the run left behind ────────────────────────────────────────────────────────────────
// The same module the binary's `hivecode run` uses: one yardstick, two ways of measuring.
const { collectRunReport } = await import("../packages/code/src/runtime/task-report")
const report = await collectRunReport({ project, startedAt, rawLogPath: rawLog })

let tests = { pass: 0, fail: 0, files: 0, ran: false }
{
  const ran = Bun.spawnSync(["bun", "test"], { cwd: project, timeout: 180_000 })
  const text = `${ran.stdout.toString()}${ran.stderr.toString()}`
  tests = {
    ran: /\d+ pass/.test(text),
    pass: Number(/(\d+) pass/.exec(text)?.[1] ?? 0),
    fail: Number(/(\d+) fail/.exec(text)?.[1] ?? 0),
    files: Number(/across (\d+) file/.exec(text)?.[1] ?? 0),
  }
}

// A task that ran out of its token budget did not finish, even if the process exited cleanly and no worker was "blocked".
// It used to show as `error: null` and "bloqueados 0": the one failure the benchmark most needs to say out loud.
const budgetWarning = warnings.find(w => /budget_exceeded/.test(w))
const budgetExceeded = report.runs.budgetExceeded || !!budgetWarning
const budgetError = budgetExceeded ? `budget_exceeded: la tarea agotó su presupuesto de tokens${budgetWarning ? ` (${(/task_[a-z_]+:\d+/.exec(budgetWarning) ?? [""])[0]})` : ""} y no entregó` : null

const result = {
  task: values.task,
  minutes: report.minutes,
  error: error ?? budgetError,
  budgetExceeded,
  integrated: report.integrated,
  hasPackageJson: report.hasPackageJson,
  leftoverWorktrees: report.leftoverWorktrees,
  projectTests: tests,
  runs: report.runs,
  reads: report.reads,
  tokens: report.tokens,
  costUsd: report.costUsd,
  workerMinutes: report.workerMinutes,
  swarm: report.swarm,
  delegations: report.delegations,
  modelOddities: report.modelOddities,
  warningsShown: warnings,
  finalAnswer: final.slice(0, 600),
}
writeFileSync(out, JSON.stringify(result, null, 2))
if (!collectOnly) setExecutionMode(previousMode)
await manager?.stopAll().catch(() => {})

const t = result
say(`resultado → ${out}`)
console.log([
  `  tiempo        ${t.minutes} min${t.error ? `  ⚠ ${t.error}` : ""}`,
  `  integrado     ${t.integrated ? "sí" : "NO"}   tests del proyecto: ${t.projectTests.pass} pasan / ${t.projectTests.fail} fallan (${t.projectTests.files} archivos)`,
  `  runs          ${t.runs.total}  bloqueados ${t.runs.blocked}  sin presupuesto ${t.runs.needsBudget}  revisiones ${t.runs.revisions}  concurrencia máx. ${t.runs.maxConcurrentWorkers}`,
  `  tokens        ${(t.tokens.input / 1e6).toFixed(1)} M entrada / ${(t.tokens.output / 1e6).toFixed(2)} M salida`,
  `  swarm         instancias ${t.swarm.instancesUsed.join(",") || "ninguna"}  fusiones ${t.swarm.mergesOk} ok / ${t.swarm.mergeConflicts} con conflicto  esperas ${t.swarm.waitFor}  sleep por shell ${t.swarm.shellSleepPolling}  herramientas simultáneas máx. ${t.swarm.maxConcurrentTools}  llamadas/paso ${t.swarm.toolCallsPerStep}`,
  `  rarezas       marcado perdido ${t.modelOddities.markupDropped}, respuestas vacías ${t.modelOddities.emptyResponses}`,
].join("\n"))
process.exit(0)
