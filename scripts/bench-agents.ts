/**
 * The same task, the same prompt, the same checks, for every coding agent.
 *
 *   bun scripts/bench-agents.ts --agents claude,codex,opencode,hivecode --tasks inventario,tareas --reps 3 --out /tmp/bench-agents/run1
 *
 * What makes the numbers comparable:
 *  - Each run starts from a fresh git repository with one empty commit, in its own directory.
 *  - The prompt is the task's `prompt.md`, word for word, for every agent. It states a precise contract.
 *  - Quality is judged by HIDDEN tests the agents never see (`bench/tasks/<task>/hidden.test.ts`), run
 *    against the finished project. The tests were validated against a reference solution first.
 *  - The user-level customisation that is not part of the agent itself (MCP servers, skills, global
 *    memory files) is switched off where the agent allows it, and every agent's fixed per-request
 *    overhead is measured separately (`--baseline`), so it can be told apart from the work.
 *  - Runs are sequential, in an order that rotates each repetition, so no agent always goes first or last.
 *  - Nothing here judges: the script records time, tokens, cost when the agent reports it, steps, the
 *    hidden-test result, and whether the agent's own `bun test` passes. Models differ between agents and
 *    are recorded as they are.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync, copyFileSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { measureCodeQuality, type CodeQuality } from "./bench-code-quality"

const ROOT = resolve(import.meta.dir, "..")
const { values } = parseArgs({
  options: {
    agents: { type: "string", default: "claude,codex,opencode,opencode-ds,hivecode" },
    tasks: { type: "string", default: "inventario,tareas" },
    reps: { type: "string", default: "1" },
    out: { type: "string" },
    "max-minutes": { type: "string", default: "45" },
    work: { type: "string", default: "/tmp/bench-agents" },
    baseline: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "opencode-model": { type: "string" },
    keep: { type: "boolean", default: false },
  },
})
if (!values.out) { console.error("uso: bun scripts/bench-agents.ts --out <dir> [--agents a,b] [--tasks t1,t2] [--reps N] [--max-minutes N] [--baseline]"); process.exit(2) }

const HIVECODE_PROVIDER = process.env.BENCH_HIVECODE_PROVIDER ?? "deepseek"
const HIVECODE_MODEL = process.env.BENCH_HIVECODE_MODEL ?? "deepseek-flash"
const out = resolve(values.out)
const workRoot = resolve(values.work!)
const maxMs = Number(values["max-minutes"]) * 60_000
mkdirSync(out, { recursive: true })
mkdirSync(workRoot, { recursive: true })

const stamp = () => new Date().toISOString().slice(11, 19)
const say = (line: string) => console.log(`[${stamp()}] ${line}`)

// ── Types ───────────────────────────────────────────────────────────────────────────────────

interface Usage {
  /** Every prompt token the model processed, cached or not, summed over all requests. */
  promptTokens: number
  outputTokens: number
  cachedTokens: number | null
  costUsd: number | null
  /** Model requests / steps, as the agent counts them. */
  steps: number | null
  toolCalls: number | null
  model: string | null
}

interface AgentRun {
  exitCode: number | null
  timedOut: boolean
  usage: Usage
  note?: string
}

interface Adapter {
  /** Model the agent ends up using by default, for the report. */
  describe(): Promise<string>
  run(input: { dir: string; prompt: string; logDir: string; maxMs: number }): Promise<AgentRun>
}

const emptyUsage = (): Usage => ({ promptTokens: 0, outputTokens: 0, cachedTokens: null, costUsd: null, steps: null, toolCalls: null, model: null })

// ── Process helper ──────────────────────────────────────────────────────────────────────────

/** Runs a command in its own process group, logs to files, and kills the whole group on timeout. */
async function exec(cmd: string[], opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs: number; stdoutPath: string; stderrPath: string }) {
  // Pipes, not files: opencode drops its final usage event when its stdout is a regular file.
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    // PWD must follow cwd: some agents (opencode) read it instead of asking the OS, and a run that inherits ours
    // works in the wrong directory. That is how one of them once ended up inside this repository.
    env: { ...process.env, PWD: opts.cwd, INIT_CWD: opts.cwd, ...opts.env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  })
  const logs = Promise.all([Bun.write(opts.stdoutPath, new Response(proc.stdout)), Bun.write(opts.stderrPath, new Response(proc.stderr))])
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { process.kill(-proc.pid, "SIGTERM") } catch { proc.kill("SIGTERM") }
    setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL") } catch { /* gone */ } }, 5_000)
  }, opts.timeoutMs)
  const exitCode = await proc.exited
  clearTimeout(timer)
  // Whatever the agent left running (a dev server, a watcher) must not outlive the run.
  try { process.kill(-proc.pid, "SIGKILL") } catch { /* nothing left */ }
  await Promise.race([logs, new Promise(resolve => setTimeout(resolve, 5_000))])
  return { exitCode, timedOut }
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf-8") : "")
const jsonLines = (text: string): any[] => text.split("\n").map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)

// ── Adapters ────────────────────────────────────────────────────────────────────────────────

const claude: Adapter = {
  async describe() { return "claude-code (modelo por defecto de la cuenta)" },
  async run({ dir, prompt, logDir, maxMs }) {
    const stdoutPath = join(logDir, "stdout.json")
    const { exitCode, timedOut } = await exec(
      ["claude", "-p", prompt, "--output-format", "json", "--dangerously-skip-permissions",
        // Not part of the agent: user MCP servers, skills and settings.
        "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "project", "--no-session-persistence"],
      { cwd: dir, timeoutMs: maxMs, stdoutPath, stderrPath: join(logDir, "stderr.log") },
    )
    const usage = emptyUsage()
    try {
      const data = JSON.parse(readText(stdoutPath))
      const u = data.usage ?? {}
      usage.promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      usage.cachedTokens = u.cache_read_input_tokens ?? 0
      usage.outputTokens = u.output_tokens ?? 0
      usage.costUsd = data.total_cost_usd ?? null
      usage.steps = data.num_turns ?? null
      usage.model = Object.keys(data.modelUsage ?? {}).join(",") || null
    } catch { /* a run killed by the timeout prints no summary */ }
    return { exitCode, timedOut, usage }
  },
}

const codex: Adapter = {
  async describe() {
    const config = readText(join(process.env.HOME ?? "", ".codex", "config.toml"))
    return `codex (${/^model\s*=\s*"([^"]+)"/m.exec(config)?.[1] ?? "modelo por defecto"})`
  },
  async run({ dir, prompt, logDir, maxMs }) {
    const stdoutPath = join(logDir, "stdout.jsonl")
    const { exitCode, timedOut } = await exec(
      ["codex", "exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--ephemeral", prompt],
      { cwd: dir, timeoutMs: maxMs, stdoutPath, stderrPath: join(logDir, "stderr.log") },
    )
    const usage = emptyUsage()
    let completedTurns = 0
    let tools = 0
    for (const event of jsonLines(readText(stdoutPath))) {
      if (event.type === "turn.completed") {
        completedTurns++
        usage.promptTokens += event.usage?.input_tokens ?? 0
        usage.cachedTokens = (usage.cachedTokens ?? 0) + (event.usage?.cached_input_tokens ?? 0)
        usage.outputTokens += (event.usage?.output_tokens ?? 0) + (event.usage?.reasoning_output_tokens ?? 0)
      }
      if (event.type === "item.completed" && event.item?.type && event.item.type !== "agent_message" && event.item.type !== "reasoning") tools++
    }
    usage.steps = completedTurns || null
    usage.toolCalls = tools
    return { exitCode, timedOut, usage }
  },
}

/** `model` pins the model (provider/model); without it opencode uses the default of its own configuration. */
const makeOpencode = (model?: string): Adapter => ({
  async describe() { return model ? `opencode (${model})` : "opencode (modelo por defecto de su configuración)" },
  async run({ dir, prompt, logDir, maxMs }) {
    // A home of its own: without the user's MCP servers and skills, like claude's --strict-mcp-config.
    // The data directory is a symlink to the real one, so the credentials are still found.
    const home = mkdtempSync(join(tmpdir(), "oc-home-"))
    mkdirSync(join(home, ".local", "share"), { recursive: true })
    try { symlinkSync(join(process.env.HOME ?? "", ".local", "share", "opencode"), join(home, ".local", "share", "opencode")) } catch { /* already there */ }
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache") }
    const stdoutPath = join(logDir, "stdout.jsonl")
    const { exitCode, timedOut } = await exec(
      ["opencode", "run", "--standalone", ...(model ? ["--model", model] : []), "--format", "json", "--auto", prompt],
      { cwd: dir, timeoutMs: maxMs, stdoutPath, stderrPath: join(logDir, "stderr.log"), env },
    )
    rmSync(home, { recursive: true, force: true })
    const usage = emptyUsage()
    // The event stream can end before its final usage event, so the totals come from the session itself.
    const sessionId = jsonLines(readText(stdoutPath)).find(e => e.sessionID)?.sessionID as string | undefined
    if (sessionId) {
      const exported = Bun.spawnSync(["opencode", "session", "export", sessionId], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 60_000 })
      try {
        writeFileSync(join(logDir, "session.json"), exported.stdout.toString())
        const session = JSON.parse(exported.stdout.toString())
        const t = session.info?.tokens ?? {}
        usage.promptTokens = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
        usage.cachedTokens = t.cache?.read ?? 0
        usage.outputTokens = (t.output ?? 0) + (t.reasoning ?? 0)
        usage.costUsd = session.info?.cost || null
        const assistants = (session.messages ?? []).filter((m: any) => m.type === "assistant")
        usage.steps = assistants.length || null
        usage.toolCalls = assistants.reduce((n: number, m: any) => n + (m.content ?? []).filter((c: any) => c.type === "tool" || c.type === "tool-call" || c.type === "tool_use").length, 0)
        usage.model = [...new Set(assistants.map((m: any) => m.model?.id).filter(Boolean))].join(",") || null
      } catch { /* a run killed by the timeout may not export */ }
    }
    return { exitCode, timedOut, usage }
  },
})
const opencode = makeOpencode(values["opencode-model"] ?? process.env.BENCH_OPENCODE_MODEL)
// Same model family as hivecode's default (DeepSeek V4.1 Flash): this pair isolates the harness.
const opencodeDeepseek = makeOpencode("opencode/deepseek-v4.1-flash-free")

const hivecode: Adapter = {
  async describe() { return `hivecode (${HIVECODE_PROVIDER} · ${HIVECODE_MODEL}, base de datos limpia)` },
  async run({ dir, prompt, logDir, maxMs }) {
    const resultPath = join(logDir, "hivecode-result.json")
    const promptFile = join(logDir, "prompt.txt")
    writeFileSync(promptFile, prompt)
    // A fresh state per run, like the other agents' stripped configuration; the API key comes from the OS keystore.
    const home = join(workRoot, `hivehome-${Date.now().toString(36)}`)
    mkdirSync(home, { recursive: true })
    const env = { HIVE_HOME: home, HIVE_DB_PATH: join(home, "db") }
    const seeded = Bun.spawnSync(["bun", join(ROOT, "scripts/bench-seed-hivecode.ts"), HIVECODE_PROVIDER, HIVECODE_MODEL], { cwd: ROOT, env: { ...process.env, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" })
    if (seeded.exitCode !== 0) return { exitCode: seeded.exitCode, timedOut: false, usage: emptyUsage(), note: `no se pudo preparar hivecode: ${seeded.stderr.toString().slice(0, 200)}` }
    const { exitCode, timedOut } = await exec(
      ["bun", join(ROOT, "scripts/bench-run.ts"), "--project", dir, "--task-file", promptFile, "--out", resultPath,
        "--max-minutes", String(maxMs / 60_000), "--stall-minutes", "10"],
      // The run enforces its own limit and has a supervisor; this outer one only catches a wrapper that never returns.
      { cwd: ROOT, env, timeoutMs: maxMs + 6 * 60_000, stdoutPath: join(logDir, "stdout.log"), stderrPath: join(logDir, "stderr.log") },
    )
    rmSync(home, { recursive: true, force: true })
    const usage = emptyUsage()
    let note: string | undefined
    try {
      const data = JSON.parse(readText(resultPath))
      usage.promptTokens = data.tokens?.input ?? 0
      usage.outputTokens = data.tokens?.output ?? 0
      usage.costUsd = data.costUsd || null
      usage.steps = data.swarm?.steps ?? data.runs?.total ?? null
      usage.toolCalls = data.swarm?.toolCalls ?? null
      usage.model = `${HIVECODE_PROVIDER}/${HIVECODE_MODEL}`
      note = data.error ?? undefined
      if (data.runs?.maxConcurrentWorkers) note = `${note ? note + " · " : ""}workers simultáneos máx. ${data.runs.maxConcurrentWorkers}`
    } catch { note = "sin resultado de hivecode" }
    return { exitCode, timedOut, usage, note }
  },
}

/** El binario distribuido, tal como lo usaría una persona: sin TUI, sin gateway, sin TTY. */
const HIVECODE_BIN = process.env.BENCH_HIVECODE_BIN ?? join(ROOT, "dist/hivecode-linux-x64")
const hivecodeBin: Adapter = {
  async describe() { return `hivecode binario (${HIVECODE_PROVIDER} · ${HIVECODE_MODEL})` },
  async run({ dir, prompt, logDir, maxMs }) {
    const resultPath = join(logDir, "hivecode-result.json")
    // Estado limpio por corrida, como el resto de agentes sin configuración del usuario.
    const home = join(workRoot, `hivehome-bin-${Date.now().toString(36)}`)
    mkdirSync(home, { recursive: true })
    const env = { HIVE_HOME: home }
    const { exitCode, timedOut } = await exec(
      [HIVECODE_BIN, "run", prompt, "--out", resultPath, "--provider", HIVECODE_PROVIDER,
        "--model", HIVECODE_MODEL, "--max-minutes", String(Math.round(maxMs / 60_000)), "--project", dir],
      { cwd: dir, env, timeoutMs: maxMs + 5 * 60_000, stdoutPath: join(logDir, "stdout.log"), stderrPath: join(logDir, "stderr.log") },
    )
    rmSync(home, { recursive: true, force: true })
    const usage = emptyUsage()
    let note: string | undefined
    try {
      const data = JSON.parse(readText(resultPath))
      usage.promptTokens = data.tokens?.input ?? 0
      usage.outputTokens = data.tokens?.output ?? 0
      usage.costUsd = data.costUsd || null
      usage.steps = data.swarm?.steps ?? data.runs?.total ?? null
      usage.toolCalls = data.swarm?.toolCalls ?? null
      usage.model = `${HIVECODE_PROVIDER}/${HIVECODE_MODEL}`
      note = data.error ?? undefined
      if (data.runs?.maxConcurrentWorkers) note = `${note ? note + " · " : ""}workers simultáneos máx. ${data.runs.maxConcurrentWorkers}`
      if (!data.integrated) note = `${note ? note + " · " : ""}el trabajo no quedó integrado en el proyecto`
    } catch { note = "sin informe del binario" }
    return { exitCode, timedOut, usage, note }
  },
}

// Controls for the evaluation itself: the reference solution must score 100 %, doing nothing must score 0 %.
const reference: Adapter = {
  async describe() { return "control: solución de referencia" },
  async run({ dir, prompt }) {
    const task = [...readdirSync(join(ROOT, "bench/tasks"))].find(t => readText(join(ROOT, "bench/tasks", t, "prompt.md")).trim() === prompt)!
    const scratch = join(dir, "..", `.r${Math.random().toString(36).slice(2, 8)}`)
    unpackEval(task, scratch)
    Bun.spawnSync(["cp", "-r", `${join(scratch, "reference")}/.`, dir])
    rmSync(scratch, { recursive: true, force: true })
    return { exitCode: 0, timedOut: false, usage: emptyUsage() }
  },
}
const nothing: Adapter = {
  async describe() { return "control: no hace nada" },
  async run() { return { exitCode: 0, timedOut: false, usage: emptyUsage() } },
}

const ADAPTERS: Record<string, Adapter> = { claude, codex, opencode, "opencode-ds": opencodeDeepseek, hivecode, "hivecode-bin": hivecodeBin, reference, nothing }

// ── Hidden material ─────────────────────────────────────────────────────────────────────────
// The hidden tests and the reference solutions live in `eval.bin` (a tar.gz) and only exist unpacked while a
// result is being judged, in a random directory. An agent that looks around the repository finds a binary.
function unpackEval(task: string, destination: string) {
  mkdirSync(destination, { recursive: true })
  const unpacked = Bun.spawnSync(["tar", "xzf", join(ROOT, "bench/tasks", task, "eval.bin"), "-C", destination])
  if (unpacked.exitCode !== 0) throw new Error(`no se pudo abrir eval.bin de ${task}`)
}

// ── Evaluation ──────────────────────────────────────────────────────────────────────────────

function parseBunTest(text: string) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "")
  return { pass: Number(/(\d+) pass/.exec(plain)?.[1] ?? 0), fail: Number(/(\d+) fail/.exec(plain)?.[1] ?? 0), ran: /\d+ pass/.test(plain) }
}

async function bunTest(args: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "test", ...args], { cwd, env: { ...process.env, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true })
  const timer = setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL") } catch { proc.kill("SIGKILL") } }, 240_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  try { process.kill(-proc.pid, "SIGKILL") } catch { /* done */ }
  return parseBunTest(`${stdout}\n${stderr}`)
}

async function evaluate(task: string, projectDir: string, runDir: string) {
  const hiddenDir = join(runDir, `.e${Math.random().toString(36).slice(2, 10)}`)
  unpackEval(task, hiddenDir)
  const hidden = await bunTest(["hidden.test.ts"], hiddenDir, { BENCH_PROJECT: projectDir })
  rmSync(hiddenDir, { recursive: true, force: true })
  const own = await bunTest([], projectDir)
  const files = Bun.spawnSync(["git", "ls-files", "--others", "--cached", "--exclude-standard"], { cwd: projectDir }).stdout.toString().split("\n").filter(f => f && !f.startsWith("node_modules/"))
  return {
    hidden: { ...hidden, total: hidden.pass + hidden.fail, ratio: hidden.pass + hidden.fail ? +(hidden.pass / (hidden.pass + hidden.fail)).toFixed(3) : 0 },
    ownTests: { pass: own.pass, fail: own.fail, green: own.ran && own.fail === 0 && own.pass > 0 },
    files: files.length,
    quality: measureCodeQuality(projectDir, files),
  }
}

/** What the repository looks like now; any difference after a run means the agent wandered into it. */
function repoState(): string {
  return Bun.spawnSync(["git", "status", "--porcelain"], { cwd: ROOT }).stdout.toString()
}

const TELLTALES = ["eval.bin", "hidden.test", "bench/tasks", "bench-agents.ts", ROOT]
function looksAtAnswers(logDir: string): boolean {
  for (const file of readdirSync(logDir)) {
    if (file === "result.json") continue
    // Un adaptador puede dejar un directorio en sus logs (un HOME propio, por ejemplo).
    if (existsSync(join(logDir, file)) && !statSync(join(logDir, file)).isFile()) continue
    const text = readText(join(logDir, file))
    if (TELLTALES.some(t => text.includes(t))) return true
  }
  return false
}

// ── A clean slate between runs ──────────────────────────────────────────────────────────────

const WORKTREES = "/tmp/hivecode-worktrees"
const listWorktrees = () => { try { return new Set(readdirSync(WORKTREES)) } catch { return new Set<string>() } }

/**
 * Kills what a run left behind and removes its temporary state, so the next agent starts from nothing.
 *
 * A server the agent started and never stopped keeps its port and the output pipe of whoever launched it; the
 * task worktrees hivecode makes under /tmp outlive the run. Only what this benchmark made is touched: processes
 * working inside its own directory, the worktrees that appeared since `worktreesBefore`, and its own leftover
 * run directories. Another session's processes and worktrees are not.
 */
function cleanSlate(worktreesBefore: Set<string>, keepRuns: boolean): string {
  const mine = [`${workRoot}/`, ...[...listWorktrees()].filter(w => !worktreesBefore.has(w)).map(w => `${WORKTREES}/${w}`)]
  let killed = 0
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    let cwd: string
    try { cwd = readlinkSync(`/proc/${entry}/cwd`) } catch { continue }
    if (!mine.some(prefix => cwd.startsWith(prefix))) continue
    try { process.kill(Number(entry), "SIGKILL"); killed++ } catch { /* already gone */ }
  }
  let removed = 0
  for (const name of listWorktrees()) {
    if (worktreesBefore.has(name)) continue
    try { rmSync(`${WORKTREES}/${name}`, { recursive: true, force: true }); removed++ } catch { /* best effort */ }
  }
  if (!keepRuns) {
    const ours = [...tasks.map(t => `${t}-`), "hivehome-", "baseline-"]
    for (const name of readdirSync(workRoot)) {
      if (!ours.some(prefix => name.startsWith(prefix))) continue
      try { rmSync(join(workRoot, name), { recursive: true, force: true }); removed++ } catch { /* best effort */ }
    }
  }
  return `${killed} proceso(s) terminado(s), ${removed} directorio(s) temporal(es) borrado(s)`
}

// ── Run one cell ────────────────────────────────────────────────────────────────────────────

interface RunResult {
  task: string
  agent: string
  rep: number
  model: string
  minutes: number
  timedOut: boolean
  exitCode: number | null
  usage: Usage
  hidden: { pass: number; fail: number; total: number; ratio: number; ran: boolean }
  ownTests: { pass: number; fail: number; green: boolean }
  files: number
  /** Measurable properties of the code it left (see bench-code-quality.ts). */
  quality: CodeQuality
  /** The agent's own transcript mentions the benchmark's hidden material: the run does not count. */
  contaminated: boolean
  note?: string
}

async function runCell(task: string, agentName: string, rep: number, prompt: string): Promise<RunResult> {
  const adapter = ADAPTERS[agentName]!
  const worktreesBefore = listWorktrees()
  say(`  limpieza previa: ${cleanSlate(worktreesBefore, !!values.keep)}`)
  const runDir = join(workRoot, `${task}-${agentName}-${rep}-${Date.now().toString(36)}`)
  const projectDir = join(runDir, "project")
  const logDir = join(out, task, `${agentName}-${rep}`)
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=bench", "-c", "user.email=bench@local", ...args], { cwd: projectDir })
  git("init", "-q", "-b", "main")
  git("commit", "-q", "--allow-empty", "-m", "inicio")

  say(`▶ ${task} · ${agentName} · rep ${rep}`)
  const repoBefore = repoState()
  const startedAt = Date.now()
  const run = await adapter.run({ dir: projectDir, prompt, logDir, maxMs })
  // The repository can change for reasons that are not the agent's (somebody is working in it), so a change in
  // `git status` is only noted. What counts is the agent's own transcript: if it mentions this repository, it
  // went looking in the wrong place and the run does not count (see `looksAtAnswers`).
  const repoChanged = repoState() !== repoBefore
  const contaminated = looksAtAnswers(logDir)
  const minutes = +((Date.now() - startedAt) / 60_000).toFixed(2)
  say(`  terminó en ${minutes} min${run.timedOut ? " (TIEMPO AGOTADO)" : ""} · evaluando…`)
  const evaluation = await evaluate(task, projectDir, runDir)
  const result: RunResult = {
    task, agent: agentName, rep, model: run.usage.model ?? (await adapter.describe()), minutes, timedOut: run.timedOut, exitCode: run.exitCode,
    usage: run.usage, hidden: { ...evaluation.hidden }, ownTests: evaluation.ownTests, files: evaluation.files, quality: evaluation.quality, contaminated, note: [run.note, repoChanged ? "el repositorio cambió durante la corrida (no necesariamente por el agente)" : ""].filter(Boolean).join(" · ") || undefined,
  }
  writeFileSync(join(logDir, "result.json"), JSON.stringify(result, null, 2))
  if (contaminated) say("  ⚠ CONTAMINADA: el registro del agente menciona el material oculto del benchmark; no cuenta")
  say(`  ocultas ${result.hidden.pass}/${result.hidden.total} · propias ${result.ownTests.green ? "verdes" : "NO verdes"} · ${(result.usage.promptTokens / 1e6).toFixed(2)} M prompt / ${(result.usage.outputTokens / 1e3).toFixed(0)} K salida${result.usage.costUsd != null ? ` · $${result.usage.costUsd.toFixed(2)}` : ""}`)
  const q = result.quality
  say(`  calidad: tipos strict ${q.strictErrors} · ${q.srcSloc} líneas en ${q.srcFiles} archivo(s) · ${q.tests} pruebas / ${q.assertions} aserciones · complejidad media ${q.ccAvg} (máx ${q.ccMax}) · duplicación ${(q.dupRatio * 100).toFixed(1)} %`)
  if (!values.keep) { try { rmSync(runDir, { recursive: true, force: true }) } catch { /* best effort */ } }
  say(`  limpieza: ${cleanSlate(worktreesBefore, !!values.keep)}`)
  return result
}

// ── Baseline: the fixed cost of one request, per agent ────────────────────────────────────────

async function baseline(agentName: string) {
  const adapter = ADAPTERS[agentName]!
  const runDir = join(workRoot, `baseline-${agentName}-${Date.now().toString(36)}`)
  const logDir = join(out, "baseline", agentName)
  mkdirSync(runDir, { recursive: true }); mkdirSync(logDir, { recursive: true })
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: runDir })
  const run = await adapter.run({ dir: runDir, prompt: "Responde solo la palabra OK. No uses herramientas.", logDir, maxMs: 5 * 60_000 })
  rmSync(runDir, { recursive: true, force: true })
  return { agent: agentName, ...run.usage, exitCode: run.exitCode }
}

// ── Summary ─────────────────────────────────────────────────────────────────────────────────

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }
const fmt = (n: number | null, digits = 1) => (n == null ? "—" : n.toFixed(digits))

function summarize(allResults: RunResult[]) {
  const results = allResults.filter(r => !r.contaminated)
  const excluded = allResults.length - results.length
  const lines: string[] = excluded ? [`\n> ${excluded} corrida(s) contaminada(s) excluida(s) de las tablas.`] : []
  for (const task of [...new Set(results.map(r => r.task))]) {
    lines.push(`\n### ${task}\n`, "| agente | n | tiempo (mediana · rango) min | tokens prompt (M) | tokens salida (K) | coste $ | pasos | herramientas | ocultas (mediana) | pruebas propias | tiempo agotado |", "|---|---|---|---|---|---|---|---|---|---|---|")
    for (const agent of [...new Set(results.filter(r => r.task === task).map(r => r.agent))]) {
      const rs = results.filter(r => r.task === task && r.agent === agent)
      const times = rs.map(r => r.minutes)
      const hidden = rs.map(r => r.hidden.ratio)
      const costs = rs.map(r => r.usage.costUsd).filter((c): c is number => c != null)
      lines.push(`| ${agent} | ${rs.length} | ${fmt(median(times))} · ${fmt(Math.min(...times))}–${fmt(Math.max(...times))} | ${fmt((median(rs.map(r => r.usage.promptTokens)) ?? 0) / 1e6, 2)} | ${fmt((median(rs.map(r => r.usage.outputTokens)) ?? 0) / 1e3, 0)} | ${costs.length ? fmt(median(costs), 2) : "—"} | ${fmt(median(rs.map(r => r.usage.steps).filter((x): x is number => x != null)), 0)} | ${fmt(median(rs.map(r => r.usage.toolCalls).filter((x): x is number => x != null)), 0)} | ${fmt((median(hidden) ?? 0) * 100, 0)} % | ${rs.filter(r => r.ownTests.green).length}/${rs.length} | ${rs.filter(r => r.timedOut).length} |`)
    }
    lines.push("", "| agente | n | tipos (errores strict) | líneas src | archivos | pruebas · aserciones | complejidad media · máx | funciones >10 | duplicación | any · ts-ignore | console | catch vacío | deps |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for (const agent of [...new Set(results.filter(r => r.task === task).map(r => r.agent))]) {
      const qs = results.filter(r => r.task === task && r.agent === agent).map(r => r.quality).filter((q): q is CodeQuality => !!q)
      const m = (pick: (q: CodeQuality) => number) => median(qs.map(pick))
      lines.push(`| ${agent} | ${qs.length} | ${fmt(m(q => q.strictErrors), 0)} | ${fmt(m(q => q.srcSloc), 0)} | ${fmt(m(q => q.srcFiles), 0)} | ${fmt(m(q => q.tests), 0)} · ${fmt(m(q => q.assertions), 0)} | ${fmt(m(q => q.ccAvg), 2)} · ${fmt(m(q => q.ccMax), 0)} | ${fmt(m(q => q.ccOver10), 0)} | ${fmt((m(q => q.dupRatio) ?? 0) * 100, 1)} % | ${fmt(m(q => q.any), 0)} · ${fmt(m(q => q.tsIgnore), 0)} | ${fmt(m(q => q.consoleCalls), 0)} | ${fmt(m(q => q.emptyCatch), 0)} | ${fmt(m(q => q.deps), 0)} |`)
    }
  }
  return lines.join("\n")
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────

const agents = values.agents!.split(",").map(a => a.trim()).filter(Boolean)
for (const a of agents) if (!ADAPTERS[a]) { console.error(`agente desconocido: ${a}`); process.exit(2) }
const tasks = values.tasks!.split(",").map(t => t.trim()).filter(Boolean)
for (const t of tasks) if (!existsSync(join(ROOT, "bench/tasks", t, "prompt.md"))) { console.error(`tarea desconocida: ${t}`); process.exit(2) }

if (values.baseline) {
  say("midiendo el coste fijo de una petición por agente")
  const rows = []
  for (const a of agents) { const row = await baseline(a); rows.push(row); say(`  ${a}: ${row.promptTokens} tokens de prompt · ${row.outputTokens} de salida`) }
  writeFileSync(join(out, "baseline.json"), JSON.stringify(rows, null, 2))
  process.exit(0)
}

const results: RunResult[] = []
const reps = Number(values.reps)
for (let rep = 1; rep <= reps; rep++) {
  for (const task of tasks) {
    const prompt = readText(join(ROOT, "bench/tasks", task, "prompt.md")).trim()
    // Rotate who goes first so no agent always runs on a cold or a busy machine.
    const order = [...agents.slice((rep - 1) % agents.length), ...agents.slice(0, (rep - 1) % agents.length)]
    for (const agent of order) {
      const resultPath = join(out, task, `${agent}-${rep}`, "result.json")
      if (existsSync(resultPath) && !values.force) { results.push(JSON.parse(readText(resultPath))); say(`= ${task} · ${agent} · rep ${rep} ya medido`); continue }
      results.push(await runCell(task, agent, rep, prompt))
      writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2))
    }
  }
}
const table = summarize(results)
writeFileSync(join(out, "summary.md"), `# Benchmark de agentes\n\nreps: ${reps} · agentes: ${agents.join(", ")} · tiempo máx. por corrida: ${values["max-minutes"]} min\n${table}\n`)
console.log(table)
process.exit(0)
